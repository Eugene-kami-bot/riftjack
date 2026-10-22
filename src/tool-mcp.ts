import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { PublicError } from './errors.js';
export type ToolAction = (input: unknown, signal: AbortSignal) => Promise<string>;
export type ToolConnection = { url: string; headers: { Authorization: string } };
export type ToolDefinition = { name: string; description: string; inputSchema: object; annotations: object };

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

// A task-local Streamable HTTP MCP endpoint. No persistent config, public listener,
// Matrix credentials or API for approving requests. Each action enforces its own
// destination scope; exposing this transport never authorizes arbitrary rooms.
export async function startToolMcp(tool: ToolDefinition, action: ToolAction, signal: AbortSignal, messages: { server: string; cancelled: string; failed: string }, options: { maxQueued?: number; maxRequestBytes?: number } = {}): Promise<ToolConnection & { close(): Promise<void> }> {
  signal.throwIfAborted();
  const maxQueued = options.maxQueued ?? 0;
  const maxRequestBytes = options.maxRequestBytes ?? 16_384;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 8 * 1024 * 1024) throw new Error('Invalid tool request size limit.');
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new Error('Invalid tool queue capacity.');
  const token = Buffer.from('Bearer ' + randomBytes(32).toString('base64url'));
  const lifetime = new AbortController();
  const requests = new Map<string | number, AbortController>();
  const used = new Set<string | number>();
  const operations = new Set<Promise<void>>();
  let active = false;
  const waiting = new Set<() => void>();
  const acquire = async (callSignal: AbortSignal) => {
    callSignal.throwIfAborted();
    if (!active) { active = true; return; }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { callSignal.removeEventListener('abort', cancelled); resolve(); };
      const cancelled = () => { waiting.delete(ready); reject(callSignal.reason); };
      waiting.add(ready);
      callSignal.addEventListener('abort', cancelled, { once: true });
    });
  };
  const release = () => {
    const next = waiting.values().next().value;
    if (next) { waiting.delete(next); next(); }
    else active = false;
  };
  let host = '';
  let closing: Promise<void> | undefined;
  const json = (res: ServerResponse, value: unknown) => {
    if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  };
  const server = createServer((req, res) => {
    const handle = async () => {
      const auth = Buffer.from(req.headers.authorization || '');
      if (auth.length !== token.length || !timingSafeEqual(auth, token)) { res.writeHead(401).end(); return; }
      // Native clients do not send Origin. Reject browser requests and DNS rebinding.
      if (req.headers.origin !== undefined || req.headers.host !== host) { res.writeHead(403).end(); return; }
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
      if (lifetime.signal.aborted) { res.writeHead(503).end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxRequestBytes) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      let message: unknown;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { json(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
      if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (message.id !== undefined && typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isSafeInteger(message.id)))) {
        json(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request.' } }); return;
      }
      const { id, method, params } = message;
      if (id === undefined) {
        if (method === 'notifications/cancelled' && record(params)) requests.get(params.requestId)?.abort();
        res.writeHead(202).end(); return;
      }
      const result = (value: unknown) => json(res, { jsonrpc: '2.0', id, result: value });
      const error = (code: number, text: string) => json(res, { jsonrpc: '2.0', id, error: { code, message: text } });
      if (method === 'initialize') {
        result({ protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-03-26',
          capabilities: { tools: {} }, serverInfo: { name: messages.server, version: '1.0.0' } }); return;
      }
      if (method === 'ping') { result({}); return; }
      if (method === 'tools/list') { result({ tools: [tool] }); return; }
      if (method !== 'tools/call') { error(-32601, 'Method not found.'); return; }
      if (used.has(id)) { error(-32600, 'Request ID already used. Tool calls are never replayed.'); return; }
      if (used.size >= 1024) { error(-32600, 'The task request limit was reached (1024 calls).'); return; }
      if (requests.size >= 1 + maxQueued) {
        error(-32600, maxQueued ? 'The tool request queue is full. Retry after a pending call completes.' : 'A tool call is already pending.'); return;
      }
      used.add(id);
      if (!record(params) || params.name !== tool.name) { error(-32602, 'Unknown tool.'); return; }
      const controller = new AbortController();
      const callSignal = AbortSignal.any([signal, lifetime.signal, controller.signal]);
      const disconnected = () => controller.abort();
      requests.set(id, controller);
      res.once('close', disconnected);
      let acquired = false;
      try {
        const input = params.arguments;
        await acquire(callSignal);
        acquired = true;
        callSignal.throwIfAborted();
        const text = await action(input, callSignal);
        callSignal.throwIfAborted();
        result({ content: [{ type: 'text', text }] });
      } catch (cause) {
        result({ isError: true, content: [{ type: 'text', text: callSignal.aborted
          ? messages.cancelled
          : cause instanceof PublicError ? cause.message : messages.failed }] });
      } finally {
        res.removeListener('close', disconnected); requests.delete(id);
        if (acquired) release();
      }
    };
    const operation = handle().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  });
  server.requestTimeout = 30_000; // Receiving a small request, not waiting for approval.
  server.headersTimeout = 10_000;
  server.timeout = 0;
  const close = () => closing ??= (async () => {
    lifetime.abort();
    signal.removeEventListener('abort', abort);
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await Promise.allSettled([...operations]);
    await stopped;
  })();
  const abort = () => { void close(); };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { await close(); throw new Error('Missing MCP listener address.'); }
  host = `127.0.0.1:${address.port}`;
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { await close(); signal.throwIfAborted(); }
  return { url: `http://${host}/mcp`, headers: { Authorization: token.toString() }, close };
}
