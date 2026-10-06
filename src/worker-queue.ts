import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { MatrixEvent } from './bridge.js';
import type { IncomingAttachment } from './media.js';

export class WorkerError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type WorkerFile = { name: string; path: string };
export type WorkerTask = {
  id: string; room: string; event: MatrixEvent; conversation: string; created: number;
  status: 'control' | 'queued' | 'leased' | 'replied' | 'delivered' | 'cancelled';
  lease?: string; leaseUntil?: number; attempt: number;
  response?: { text: string; files: WorkerFile[] };
  delivery?: { events: unknown[]; next: number };
  attachment?: IncomingAttachment;
};

// One database per bot; only the connector opens it. A committed enqueue precedes
// the Matrix sync checkpoint. Replies and outbound transaction IDs survive restarts.
export class WorkerQueue {
  private db: DatabaseSync;
  constructor(file: string, private now = Date.now, readonly leaseMs = 300_000) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status)');
  }
  close() { this.db.close(); }
  private save(task: WorkerTask) {
    this.db.prepare('UPDATE jobs SET status = ?, body = ? WHERE id = ?').run(task.status, JSON.stringify(task), task.id);
  }
  list(status?: WorkerTask['status']): WorkerTask[] {
    const rows = status ? this.db.prepare('SELECT body FROM jobs WHERE status = ? ORDER BY rowid').all(status)
      : this.db.prepare('SELECT body FROM jobs ORDER BY rowid').all();
    return rows.map(row => JSON.parse(row.body as string));
  }
  get(id: string): WorkerTask {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id = ?').get(id);
    if (!row) throw new WorkerError(404, 'Task not found.');
    return JSON.parse(row.body as string);
  }
  enqueue(room: string, event: MatrixEvent, conversation: string, control = false): WorkerTask {
    const existing = this.db.prepare('SELECT body FROM jobs WHERE event_id = ?').get(event.event_id!);
    if (existing) return JSON.parse(existing.body as string);
    const task: WorkerTask = { id: randomUUID(), room, event, conversation, created: this.now(), status: control ? 'control' : 'queued', attempt: 0 };
    this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)').run(task.id, event.event_id!, task.status, JSON.stringify(task));
    return task;
  }
  candidate(): WorkerTask | undefined {
    // Keep idle long polls independent of completed conversation history.
    if (this.db.prepare("SELECT id FROM jobs WHERE status = 'leased' AND json_extract(body, '$.leaseUntil') > ? LIMIT 1").get(this.now())) return;
    const row = this.db.prepare("SELECT body FROM jobs WHERE status = 'queued' OR (status = 'leased' AND json_extract(body, '$.leaseUntil') <= ?) ORDER BY rowid LIMIT 1").get(this.now());
    return row ? JSON.parse(row.body as string) : undefined;
  }

  claim(id: string): WorkerTask | undefined {
    const candidate = this.candidate();
    if (!candidate || candidate.id !== id) return;
    candidate.status = 'leased'; candidate.lease = randomUUID();
    candidate.leaseUntil = this.now() + this.leaseMs; candidate.attempt++;
    this.save(candidate); return candidate;
  }
  checkLease(id: string, lease: string): WorkerTask {
    const task = this.get(id);
    if (task.status !== 'leased' || task.lease !== lease || task.leaseUntil! <= this.now()) throw new WorkerError(409, 'Lease expired, cancelled or replaced. Fetch task status before doing more work.');
    return task;
  }
  renew(id: string, lease: string): WorkerTask {
    const task = this.checkLease(id, lease); task.leaseUntil = this.now() + this.leaseMs; this.save(task); return task;
  }
  cacheAttachment(id: string, lease: string, attachment: IncomingAttachment) {
    const task = this.checkLease(id, lease);
    task.attachment = attachment; this.save(task);
  }
  release(id: string, lease: string) {
    const task = this.checkLease(id, lease); task.status = 'queued'; delete task.lease; delete task.leaseUntil; this.save(task);
  }
  complete(id: string, lease: string, text: string, files: WorkerFile[]): WorkerTask {
    const task = this.get(id), response = { text, files };
    if (['replied', 'delivered'].includes(task.status) && task.lease === lease) {
      if (JSON.stringify(task.response) !== JSON.stringify(response)) throw new WorkerError(409, 'A different reply was already accepted.');
      return task;
    }
    this.checkLease(id, lease);
    task.response = response; task.status = 'replied'; this.save(task); return task;
  }
  prepare(id: string, events: unknown[]) {
    const task = this.get(id);
    if (task.status !== 'replied') throw new WorkerError(409, 'Task is not awaiting delivery.');
    if (!task.delivery) { task.delivery = { events, next: 0 }; this.save(task); }
  }
  deliveredPart(id: string) {
    const task = this.get(id);
    if (task.status !== 'replied' || !task.delivery) throw new WorkerError(409, 'Delivery was cancelled.');
    task.delivery.next++;
    if (task.delivery.next === task.delivery.events.length) task.status = 'delivered';
    this.save(task);
  }
  cancel(id: string) {
    const task = this.get(id);
    if (!['delivered', 'cancelled'].includes(task.status)) { task.status = 'cancelled'; this.save(task); }
  }
  cancelWhere(predicate: (task: WorkerTask) => boolean) {
    for (const task of this.list()) if (predicate(task)) this.cancel(task.id);
  }
  transaction(id: string, part: number) { return 'worker-' + createHash('sha256').update(id + ':' + part).digest('hex'); }
}
