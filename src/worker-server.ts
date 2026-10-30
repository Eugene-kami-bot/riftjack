import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PublicError } from './errors.js';
import { WorkerError } from './worker-queue.js';
import type { WorkerService } from './worker-service.js';
import type { RoomMessageTool } from './room-messages.js';

export class WorkerServer {
  private bots = new Map<string, { token: string; reviewToken?: string; service: WorkerService; rooms?: RoomMessageTool }>();
  private controllers = new Set<AbortController>();
  private server = createServer((request, response) => { void this.handle(request, response); });
  add(bot: string, token: string, service: WorkerService, rooms?: RoomMessageTool, reviewToken?: string) {
    this.bots.set(bot, { token, reviewToken, service, rooms });
  }
  remove(bot: string) { this.bots.delete(bot); }
  async start(port: number) {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    return (this.server.address() as { port: number }).port;
  }
  async stop() {
    for (const controller of this.controllers) controller.abort();
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController(); this.controllers.add(controller);
    let roomsRequest = false;
    response.on('close', () => controller.abort());
    const send = (status: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.headers.origin) throw new WorkerError(403, 'Browser requests are not supported.');
      const url = new URL(request.url || '/', 'http://localhost');
      const match = /^\/v1\/bots\/([^/]+)\/(tasks|rooms)(?:\/([a-f0-9-]{36})(?:\/(renew|release|reply|attachment))?)?$/.exec(url.pathname);
      const selected = match && this.bots.get(decodeURIComponent(match[1]));
      const bearer = request.headers.authorization?.replace(/^Bearer /, '') || '';
      const matches = (candidate?: string) => !!candidate && Buffer.byteLength(bearer) === Buffer.byteLength(candidate) &&
        timingSafeEqual(Buffer.from(bearer), Buffer.from(candidate));
      const reviewCredentials = !!selected && matches(selected.reviewToken);
      if (!selected || (!matches(selected.token) && !reviewCredentials)) throw new WorkerError(401, 'Invalid bot credentials.');
      if (reviewCredentials && match![2] !== 'rooms') throw new WorkerError(403, 'Review supervisor credentials are restricted to review requests.');
      const { service } = selected;
      if (match![2] === 'rooms') {
        roomsRequest = true;
        if (!selected.rooms || request.method !== 'POST' || match![3]) throw new WorkerError(404, 'Unknown worker endpoint.');
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 32_768) throw new WorkerError(413, 'Request too large.');
          chunks.push(Buffer.from(chunk));
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new WorkerError(400, 'Expected JSON.'); }
        if ((body?.action === 'request_review') !== reviewCredentials) {
          throw new WorkerError(403, reviewCredentials
            ? 'Review supervisor credentials are restricted to review requests.'
            : 'Managed-review requests require separate supervisor credentials.');
        }
        const result = await selected.rooms(body, controller.signal);
        send(200, JSON.parse(result)); return;
      }
      const id = match![3], action = match![4];
      if (request.method === 'GET' && !id) {
        const seconds = Number(url.searchParams.get('wait') || '0');
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw new WorkerError(400, 'wait must be between 0 and 30 seconds.');
        const until = Date.now() + seconds * 1000;
        do {
          controller.signal.throwIfAborted();
          const task = await service.claim();
          if (task) { send(200, { task }); return; }
          if (Date.now() >= until) break;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, Math.min(250, until - Date.now()));
            controller.signal.addEventListener('abort', done, { once: true });
          });
        } while (!controller.signal.aborted);
        send(200, { task: null }); return;
      }
      if (request.method === 'GET' && id && !action) { send(200, await service.status(id)); return; }
      if (request.method !== 'POST' || !id || !action) throw new WorkerError(404, 'Unknown worker endpoint.');
      const limit = Math.ceil(service.maxBytes * 4 / 3) + 300_000;
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) throw new WorkerError(413, 'Request too large.');
        chunks.push(Buffer.from(chunk));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new WorkerError(400, 'Expected JSON.'); }
      if (!body || typeof body.lease !== 'string') throw new WorkerError(400, 'Task lease is required.');
      const result = action === 'renew' ? await service.renew(id, body.lease)
        : action === 'release' ? await service.release(id, body.lease)
        : action === 'attachment' ? await service.attachment(id, body.lease)
        : await service.complete(id, body.lease, body);
      send(200, result);
    } catch (error) {
      if (!controller.signal.aborted) {
        const expectedRoomError = roomsRequest && error instanceof PublicError;
        send(error instanceof WorkerError ? error.status : expectedRoomError ? 400 : 503,
          { error: error instanceof WorkerError || expectedRoomError ? error.message : 'Worker service is temporarily unavailable.' });
      }
    } finally { this.controllers.delete(controller); }
  }
}
