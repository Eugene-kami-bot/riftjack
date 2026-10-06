import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkerError, WorkerQueue, type WorkerTask, type WorkerFile } from './worker-queue.js';
import { readOutgoing, safeName, type IncomingAttachment } from './media.js';

export type WorkerTransport = {
  allowed: (task: WorkerTask) => Promise<boolean>;
  receive: (task: WorkerTask) => Promise<IncomingAttachment | undefined>;
  prepare: (task: WorkerTask) => Promise<unknown[]>;
  send: (task: WorkerTask, transaction: string, encrypted: unknown) => Promise<void>;
  report: (error: unknown) => void;
};
export class WorkerService {
  private delivering = false;
  private stopped = false;
  private downloads = new Map<string, Promise<IncomingAttachment>>();
  constructor(readonly queue: WorkerQueue, private files: string, readonly maxBytes: number, private transport: WorkerTransport) {}
  get busy() { return this.delivering; }
  stop() { this.stopped = true; }
  private async allowed(task: WorkerTask) {
    if (this.stopped) throw new WorkerError(503, 'Connector is stopping.');
    const allowed = await this.transport.allowed(task);
    if (this.stopped) throw new WorkerError(503, 'Connector is stopping.');
    if (!allowed) {
      this.queue.cancel(task.id);
      throw new WorkerError(403, 'Task access or room privacy changed.');
    }
  }
  async claim() {
    const candidate = this.queue.candidate();
    if (candidate) {
      try { await this.allowed(candidate); }
      catch (error) { if (error instanceof WorkerError && error.status === 403) return null; throw error; }
      const task = this.queue.claim(candidate.id);
      if (!task) return null;
      return { id: task.id, conversation: task.conversation, sender: task.event.sender,
        text: task.event.content?.body || '', hasAttachment: !!task.event.content?.file,
        lease: task.lease, leaseUntil: task.leaseUntil, attempt: task.attempt };
    }
    return null;
  }
  async status(id: string) {
    const task = this.queue.get(id); await this.allowed(task);
    return { id, status: task.status, leaseUntil: task.leaseUntil, attempt: task.attempt };
  }
  async renew(id: string, lease: string) {
    await this.allowed(this.queue.checkLease(id, lease));
    return { leaseUntil: this.queue.renew(id, lease).leaseUntil };
  }
  async release(id: string, lease: string) {
    await this.allowed(this.queue.checkLease(id, lease)); this.queue.release(id, lease);
    return { released: true };
  }
  async attachment(id: string, lease: string) {
    let task = this.queue.checkLease(id, lease); await this.allowed(task);
    task = this.queue.checkLease(id, lease);
    let download = this.downloads.get(id);
    if (!task.attachment && !download) {
      download = (async () => {
        const file = await this.transport.receive(task);
        this.queue.checkLease(id, lease); await this.allowed(task);
        if (!file) throw new WorkerError(404, 'This task has no attachment.');
        this.queue.cacheAttachment(id, lease, file);
        return file;
      })();
      this.downloads.set(id, download);
      void download.finally(() => { if (this.downloads.get(id) === download) this.downloads.delete(id); }).catch(() => {});
    }
    const file = task.attachment ?? await download!;
    const data = await readOutgoing({ path: file.path, root: dirname(file.path) }, this.maxBytes);
    // Cached reads still require a live lease and current room authorization.
    this.queue.checkLease(id, lease); await this.allowed(this.queue.get(id));
    this.queue.checkLease(id, lease);
    return { name: file.name, mimetype: file.mimetype, data: data.toString('base64') };
  }
  async complete(id: string, lease: string, body: unknown) {
    if (!body || typeof body !== 'object') throw new WorkerError(400, 'Expected a reply object.');
    const { text = '', files = [] } = body as { text?: unknown; files?: unknown };
    if (typeof text !== 'string' || text.length > 40_000 || !Array.isArray(files) || files.length > 10 || (!text.trim() && !files.length)) throw new WorkerError(400, 'Supply text (up to 40,000 characters) and/or up to 10 files.');
    const task = this.queue.get(id); await this.allowed(task);
    if (!['replied', 'delivered'].includes(task.status)) this.queue.checkLease(id, lease);
    else if (task.lease !== lease) throw new WorkerError(409, 'Different task lease.');
    let total = 0;
    const decoded = files.map(file => {
      if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255 || typeof file.data !== 'string' || (file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))) throw new WorkerError(400, 'Files need a name of at most 255 characters and base64 data.');
      const data = Buffer.from(file.data, 'base64'); total += data.length;
      if (total > this.maxBytes) throw new WorkerError(413, 'Reply attachments exceed the total size limit.');
      return { name: safeName(file.name), data };
    });
    await this.allowed(task);
    mkdirSync(this.files, { recursive: true, mode: 0o700 });
    const stored: WorkerFile[] = decoded.map(({ name, data }) => {
      const directory = join(this.files, createHash('sha256').update(data).digest('hex'));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, name);
      try { writeFileSync(path, data, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return { name, path };
    });
    const accepted = this.queue.complete(id, lease, text, stored);
    void this.deliver();
    return { id, status: accepted.status }; // Accepted is distinct from Matrix delivery.
  }
  async deliver() {
    if (this.delivering || this.stopped) return;
    this.delivering = true;
    try {
      for (const pending of this.queue.list('replied')) {
        try {
          await this.allowed(pending);
          if (!pending.delivery) this.queue.prepare(pending.id, await this.transport.prepare(pending));
          let task = this.queue.get(pending.id);
          while (task.status === 'replied' && task.delivery && task.delivery.next < task.delivery.events.length) {
            await this.allowed(task);
            // Check cancellation after asynchronous access checks, before sending.
            if (this.queue.get(task.id).status !== 'replied') break;
            await this.transport.send(task, this.queue.transaction(task.id, task.delivery.next), task.delivery.events[task.delivery.next]);
            this.queue.deliveredPart(task.id); task = this.queue.get(task.id);
          }
        } catch (error) { this.transport.report(error); }
      }
    } catch (error) { this.transport.report(error); }
    finally { this.delivering = false; }
  }
}
