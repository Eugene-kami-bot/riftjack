import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJson, syncDirectory } from '../scripts/executor-storage.mjs';
import { parseExecutorRequest, type ExecutorPolicy, type RunRequest } from './executor-protocol.js';

export type ExecutorEvent = { type?: string; sender?: string; event_id?: string; origin_server_ts?: number;
  content?: { msgtype?: string; body?: string; 'm.relates_to'?: { rel_type?: string } } };
type Result = { status: string; pid?: number; started?: number; updated?: number; finished?: number; code?: number | null; signal?: string | null; bytes?: number };
type Job = { request: RunRequest; policy: string; room: string; sender: string; event: string; dir: string; state: string;
  offset: number; progressAt: number; wakeAt?: number; wakeOffset?: number; reported?: boolean; uncertaintyReported?: boolean; result?: Result };
export type ExecutorPost = { id: string; room: string; sender: string; event: string; body: string; file?: string; wake?: { jobId: string; reason: 'completed' | 'uncertain' | 'response' | 'progress' }; encrypted?: unknown };
type Saved = { version: 1; since: number; heads: Record<string, string>; events: string[]; jobs: Job[]; outbox: ExecutorPost[]; sequence: number };
export type ExecutorTransport = {
  allowed(room: string, sender: string): Promise<boolean>;
  prepare(post: ExecutorPost): Promise<unknown>;
  send(post: ExecutorPost): Promise<void>;
};
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'output_limit']);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function saveExecutorJson(path: string, value: unknown) {
  saveJson(path, value);
}
export class ExecutorQueue {
  private data: Saved;
  private pumping = false;
  private savedJson?: string;
  constructor(private dir: string, readonly bot: string, readonly policy: ExecutorPolicy,
    private launch = (directory: string) => {
      const runner = fileURLToPath(new URL('../scripts/executor-runner.mjs', import.meta.url));
      const child = spawn(process.execPath, [runner, directory], { detached: true, stdio: 'ignore',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: policy.workspace } });
      child.on('error', () => {}); // Unknown launch results remain uncertain, never rerun automatically.
      child.unref();
    }) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'queue.json');
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) :
      { version: 1, since: Date.now(), heads: {}, events: [], jobs: [], outbox: [], sequence: 0 };
    if (this.data.version !== 1 || !Array.isArray(this.data.jobs) || !Array.isArray(this.data.events) || !Array.isArray(this.data.outbox)) throw new Error('Invalid executor queue; restore its state instead of resetting it.');
    this.save();
  }
  get since() { return this.data.since; }
  get heads() { return { ...this.data.heads }; }
  saveHeads(heads: Record<string, string>) { this.data.heads = heads; this.save(); }
  private save() {
    const next = JSON.stringify(this.data);
    if (next === this.savedJson) return;
    saveExecutorJson(join(this.dir, 'queue.json'), this.data); this.savedJson = next;
  }
  private post(room: string, sender: string, event: string, body: string, file?: string, wake?: ExecutorPost['wake']) {
    this.data.outbox.push({ id: hash(this.bot + ':' + this.data.since + ':' + ++this.data.sequence), room, sender, event, body, ...(file && { file }), ...(wake && { wake }) });
  }
  private describe(job: Job) {
    const r = job.result;
    const elapsed = r?.started ? Math.floor(((r.finished ?? Date.now()) - r.started) / 1000) : 0;
    return `${job.request.id}: ${job.state}; elapsed ${elapsed}s; exit ${r?.code ?? 'unknown'}; signal ${r?.signal ?? 'none'}; mode ${this.policy.mode}.`;
  }
  async receive(room: string, event: ExecutorEvent, allowed: ExecutorTransport['allowed']) {
    if (!this.policy.rooms.includes(room) || !event.sender || !this.policy.senders.includes(event.sender) || event.sender === this.bot ||
      event.type !== 'm.room.message' || !event.event_id || event.content?.msgtype !== 'm.text' ||
      event.content['m.relates_to']?.rel_type === 'm.replace' || !event.content.body?.startsWith(`!exec ${this.bot} `) ||
      !Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < this.data.since) return;
    if (this.data.events.includes(event.event_id)) return;
    if (!await allowed(room, event.sender)) return;
    // Recheck after the asynchronous room check; sync and delivery can overlap.
    if (this.data.events.includes(event.event_id)) return;
    if (this.data.events.length >= 10000 || this.data.outbox.length >= 1000) throw new Error('Executor journal is full; archive it locally before accepting more work.');
    let response: ExecutorPost['wake'];
    const reply = (text: string, file?: string) => this.post(room, event.sender!, event.event_id!, text, file, response);
    try {
      const request = parseExecutorRequest(event.content.body, this.bot, this.policy)!;
      if (request.action !== 'run') response = { jobId: request.id, reason: 'response' };
      const job = this.data.jobs.find(j => j.request.id === request.id);
      if (request.action === 'run') {
        if (job) {
          if (job.room !== room || job.sender !== event.sender || JSON.stringify(job.request) !== JSON.stringify(request)) reply('Job ID already exists with a different request or owner. Use a new ID for new work.');
          else reply(this.describe(job) + ' Existing job retained; nothing was restarted.');
        } else if (this.data.jobs.length >= 1000) reply('Executor job journal is full; ask the owner to archive it.');
        else {
          const directory = join(this.dir, 'jobs', hash(request.id)); mkdirSync(directory, { recursive: true, mode: 0o700 }); syncDirectory(join(this.dir, 'jobs')); syncDirectory(this.dir);
          this.data.jobs.push({ request, policy: hash(JSON.stringify(this.policy)), room, sender: event.sender!, event: event.event_id!, dir: directory, state: 'queued', offset: 0, progressAt: 0 });
          reply(`${request.id}: queued; mode ${this.policy.mode}; timeout ${request.timeoutSeconds}s.`);
        }
      } else if (!job || job.room !== room) reply('No such job in this room.');
      else if (request.action === 'cancel') {
        if (job.state === 'queued') job.state = 'cancelled';
        else if (!terminal.has(job.state)) writeFileSync(join(job.dir, 'cancel'), 'cancel', { mode: 0o600 });
        reply(this.describe(job) + ' Cancellation requested; completed effects are not undone.');
      } else if (request.action === 'log') {
        const file = join(job.dir, 'output.log');
        if (!existsSync(file)) reply(this.describe(job) + ' No output yet.');
        else {
          // A stable snapshot can be encrypted and retried while the live log grows.
          const snapshot = join(job.dir, `snapshot-${hash(event.event_id!)}.log`);
          writeFileSync(snapshot, readFileSync(file), { mode: 0o600 });
          reply(this.describe(job), snapshot);
        }
      } else reply(this.describe(job));
    } catch (error) { reply(error instanceof Error ? error.message : 'Invalid executor request.'); }
    this.data.events.push(event.event_id); this.save();
  }
  private refresh(job: Job) {
    const file = join(job.dir, 'result.json');
    if (existsSync(file)) {
      const result: Result = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof result.status !== 'string' || !Number.isFinite(result.updated)) throw new Error('Invalid runner result.');
      job.result = result;
      job.state = terminal.has(result.status) ? result.status : Date.now() - result.updated! > 30000 ? 'uncertain' : 'running';
    } else if (job.state === 'starting') job.state = 'uncertain';
  }
  async tick(transport: ExecutorTransport) {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const job of this.data.jobs) {
        if (['starting', 'running', 'uncertain'].includes(job.state)) this.refresh(job);
        if (this.data.outbox.length >= 50) continue;
        if (job.state === 'uncertain' && !job.uncertaintyReported) {
          this.post(job.room, job.sender, job.event, this.describe(job) + ' Queue paused. Inspect the supervisor and existing effects; the command will not be restarted automatically.', undefined, { jobId: job.request.id, reason: 'uncertain' });
          job.uncertaintyReported = true;
        }
        const log = join(job.dir, 'output.log');
        const size = existsSync(log) ? statSync(log).size : 0;
        if (job.state === 'running' && size > job.offset && Date.now() - job.progressAt >= 10000) {
          const fd = openSync(log, 'r'), buffer = Buffer.alloc(Math.min(4000, size - job.offset));
          try { readSync(fd, buffer, 0, buffer.length, job.offset); } finally { closeSync(fd); }
          this.post(job.room, job.sender, job.event, `${this.describe(job)}\nOutput bytes ${job.offset}–${job.offset + buffer.length}:\n${buffer.toString('utf8')}`);
          job.offset += buffer.length; job.progressAt = Date.now();
        }
        const interval = job.request.wakeIntervalSeconds;
        if (job.state === 'running' && interval && size > (job.wakeOffset ?? 0) && Date.now() - (job.wakeAt ?? 0) >= interval * 1000) {
          // Wake with the newest output, independently of the room log cursor.
          // Coalesce only unsent, unencrypted notices; encrypted retries keep their transaction.
          this.data.outbox = this.data.outbox.filter(p => !(p.event === job.event && p.wake?.reason === 'progress' && !p.encrypted));
          const start = Math.max(job.wakeOffset ?? 0, size - 2000);
          const fd = openSync(log, 'r'), buffer = Buffer.alloc(size - start);
          try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
          this.post(job.room, job.sender, job.event, `${this.describe(job)}\nLatest output bytes ${start}–${size}:\n${buffer.toString('utf8')}`,
            undefined, { jobId: job.request.id, reason: 'progress' });
          job.wakeAt = Date.now(); job.wakeOffset = size;
        }
        if (terminal.has(job.state) && !job.reported) {
          this.data.outbox = this.data.outbox.filter(p => !(p.event === job.event && p.wake?.reason === 'progress' && !p.encrypted));
          this.post(job.room, job.sender, job.event, this.describe(job) + (size ? '\nComplete captured stdout/stderr log attached.' : ''), size ? log : undefined, { jobId: job.request.id, reason: 'completed' });
          job.reported = true;
        }
      }
      this.save();
      if (!this.data.jobs.some(j => ['starting', 'running', 'uncertain'].includes(j.state))) {
        const job = this.data.jobs.find(j => j.state === 'queued');
        if (job) {
          const permitted = job.policy === hash(JSON.stringify(this.policy)) && await transport.allowed(job.room, job.sender);
          if (job.state === 'queued') {
            if (!permitted) job.state = 'cancelled';
            else {
              saveExecutorJson(join(job.dir, 'spec.json'), { ...job.request, maxLogBytes: 8 * 1024 * 1024,
                env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.policy.workspace, LANG: 'C.UTF-8' } });
              // Persist BEFORE spawn. An uncertain spawn can block the queue, never execute twice.
              job.state = 'starting'; job.wakeAt = Date.now(); this.save(); this.launch(job.dir);
              this.post(job.room, job.sender, job.event, `${job.request.id}: starting; mode ${this.policy.mode}.`);
            }
            this.save();
          }
        }
      }
      const post = this.data.outbox[0];
      if (post) {
        if (!await transport.allowed(post.room, post.sender)) { this.data.outbox.shift(); this.save(); return; }
        if (!post.encrypted) { post.encrypted = await transport.prepare(post); this.save(); }
        if (!await transport.allowed(post.room, post.sender)) return;
        await transport.send(post);
        this.data.outbox.shift(); this.save();
      }
    } finally { this.pumping = false; }
  }
}
