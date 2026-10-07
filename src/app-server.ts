import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Config } from './config.js';
import { deniedRequest } from './codex-interactions.js';
import { PublicError } from './errors.js';
import { codexAccountFailure } from './auth-diagnostics.js';

export type AgentMessage = { type: string; id: string; text?: string; phase?: string | null };
export type Turn = { id: string; status: string; items?: AgentMessage[] };
export type Notification = { method: string; params: { threadId?: string; turnId?: string; turn?: Turn; item?: AgentMessage; requestId?: string | number; tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number | null } } };
export type ServerRequest = { id: string | number; method: string; params: Record<string, any> };
export type RequestHandler = (request: ServerRequest, signal: AbortSignal) => Promise<object | undefined>;
export type CodexInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string };

// Only connector-owned operation names may appear in diagnostics, never RPC parameters.
const operations = new Set(['initialize', 'account/read', 'account/rateLimits/read', 'thread/start',
  'thread/resume', 'thread/inject_items', 'turn/start', 'turn/steer', 'turn/interrupt', 'plugin/read', 'plugin/install']);
const operationName = (method: string) => operations.has(method) ? method : 'request';

export class RpcError extends PublicError {
  constructor(readonly code: number, message?: unknown, method = 'request') {
    // Map only a known server error; never forward arbitrary diagnostics to chat.
    const busy = code === -32600 && typeof message === 'string' &&
      /^thread [a-zA-Z0-9_-]+ already has an active writer$/.test(message);
    const detail = code === -32603 && method === 'account/read'
      ? ` Diagnostic: ${codexAccountFailure(message)}.` : '';
    super(busy
      ? 'This conversation is already open in another Codex process. Close it in the Codex app or finish the other active session, then retry in Matrix. No conversation reset is needed.'
      : `Codex App Server rejected ${operationName(method)}${Number.isSafeInteger(code) ? ` (RPC ${code})` : ''}.${detail}`);
  }
}

// JSONL over private stdio pipes; no HTTP listener and no connector credentials in the child.
export class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { method: string; resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private failure?: Error;
  private closing = false;
  private closed: Promise<void>;
  private incoming = new Map<string | number, { request: ServerRequest; controller: AbortController }>();

  constructor(config: Config, onNotification: (message: Notification) => void, onFailure: (error: Error) => void, onRequest?: RequestHandler) {
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT']) {
      if (process.env[name]) env[name] = process.env[name]!;
    }
    const args = ['app-server', '--listen', 'stdio://',
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      '-c', `approval_policy="${onRequest ? config.codexApprovalPolicy : 'never'}"`, '-c', `sandbox_mode="${config.sandbox}"`,
      '-c', 'sandbox_workspace_write.network_access=false', '-c', 'web_search="disabled"'];
    this.child = spawn(config.codexPath, args, { cwd: config.workspace, env, stdio: 'pipe' });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      this.cancelIncoming();
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      onFailure(error);
    };
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      fail(new PublicError(`Codex App Server exited${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}.`)); resolve();
    }));
    this.child.once('error', () => fail(new PublicError('Could not start Codex CLI. Install it on the host and set CODEX_PATH to its executable if it is not on PATH.')));
    this.child.stdin.on('error', () => fail(new PublicError('Codex App Server input pipe failed.')));
    // Diagnostics from Codex may contain sensitive data. Do not forward them verbatim.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          if ((typeof message.id !== 'string' && typeof message.id !== 'number') || !message.params || typeof message.params !== 'object' || this.incoming.has(message.id)) throw new Error('Invalid server request.');
          const entry = { request: message as ServerRequest, controller: new AbortController() };
          this.incoming.set(message.id, entry);
          // Do not block the JSONL reader: answers, cancellation and other requests keep flowing.
          void (async () => {
            let result: object | undefined;
            try { result = this.incoming.size <= 10 ? await onRequest?.(entry.request, entry.controller.signal) : undefined; }
            catch { /* Fail closed, without logging user answers or server diagnostics. */ }
            if (entry.controller.signal.aborted || this.closing || this.failure) return;
            this.incoming.delete(message.id);
            result ??= deniedRequest(message.method);
            this.write(result !== undefined ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: 'This interactive request is not supported by this connector.' } });
          })().catch(() => fail(new PublicError('Could not answer Codex App Server request.')));
        } else if (message.method) {
          if (message.method === 'serverRequest/resolved') {
            const entry = this.incoming.get(message.params?.requestId);
            if (entry?.request.params.threadId === message.params.threadId) {
              this.incoming.delete(message.params.requestId); entry?.controller.abort();
            }
          }
          if (message.method === 'turn/completed') this.cancelIncoming(message.params?.threadId, message.params?.turn?.id);
          onNotification(message);
        } else {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id); clearTimeout(request.timer);
          if (message.error) request.reject(new RpcError(message.error.code, message.error.message, request.method));
          else request.resolve(message.result);
        }
      } catch { fail(new PublicError('Could not process a Codex App Server response. Check the installed Codex version.')); }
    });
  }

  private write(value: object): void { this.child.stdin.write(JSON.stringify(value) + '\n'); }

  private cancelIncoming(threadId?: string, turnId?: string): void {
    for (const [id, entry] of this.incoming) {
      if (!threadId || (entry.request.params.threadId === threadId && (!entry.request.params.turnId || entry.request.params.turnId === turnId))) {
        this.incoming.delete(id); entry.controller.abort();
      }
    }
  }

  request<T>(method: string, params: object, timeoutMs = 30_000): Promise<T> {
    if (this.failure || this.closing) return Promise.reject(this.failure || new PublicError('Codex App Server is closing.'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new PublicError(`Codex App Server timed out waiting for ${operationName(method)} after ${Math.ceil(timeoutMs / 1000)} seconds. No automatic retry was made; check the task state before retrying.`));
      }, timeoutMs);
      this.pending.set(id, { method: operationName(method), resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'matrix_connector', title: 'Matrix Connector', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: 'initialized', params: {} });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    this.cancelIncoming();
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill('SIGTERM'), 250);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    try { await this.closed; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
}
