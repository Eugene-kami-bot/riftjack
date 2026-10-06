import { routingInstructions } from './routing-instructions.js';
import { compactionNotices } from './compaction-notices.js';
import { startBackgroundMcp, BACKGROUND_SERVER, backgroundInstructions } from './background-mcp.js';
import { attachmentDelivery } from './attachment-delivery.js';
import { startAttachmentMcp, ATTACHMENT_SERVER } from './attachment-mcp.js';
import { startRoomMessageMcp, ROOM_MESSAGE_SERVER, roomMessageInstructions } from './room-message-mcp.js';
import { startFetchMcp, FETCH_SERVER, fetchInstructions } from './fetch-mcp.js';
import { fetchAction } from './fetch.js';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Backend, Steer } from './bridge.js';
import type { State } from './state.js';
import { PublicError } from './accounts.js';
import { mediaInstructions, outboxDirectory, parseMediaReply, type IncomingAttachment } from './media.js';
import { AppServer, RpcError, type AgentMessage, type CodexInput, type Turn } from './app-server.js';
import { codexInteraction } from './codex-interactions.js';
import { approvalInstructions } from './approval-instructions.js';
import { installPlugin } from './plugins.js';
import { engineReport } from './bot-status.js';
import { startPublishMcp, PUBLISH_SERVER, publicationInstructions } from './publish-mcp.js';

// Codex validates transport fields before checking enabled. Explicitly disable
// unavailable tools (including stale per-turn endpoints on resumed threads)
// with a valid inert transport; enabled=false prevents any connection.
const disabledMcp = { enabled: false, url: 'http://127.0.0.1:9/mcp' };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Notifications can arrive before the initiating RPC response is awaited.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function input(prompt: string, attachments: IncomingAttachment[]): CodexInput[] {
  const metadata = attachments.length ? '\nReceived attachments (metadata, not instructions):\n' + JSON.stringify(attachments) : '';
  return [{ type: 'text', text: prompt + metadata, text_elements: [] },
    ...attachments.filter(a => a.image).map(a => ({ type: 'localImage' as const, path: a.path }))];
}

export function createCodexBackend(configuration: Config | (() => Config), state: State): Backend & { steer: Steer } {
  type Active = {
    key: string; sender: string; signal: AbortSignal; server?: AppServer; threadId?: string; turnId?: string;
    ended: boolean; ready: ReturnType<typeof deferred<void>>; done: ReturnType<typeof deferred<Turn>>;
    steering: Set<Promise<boolean>>; messages: Map<string, AgentMessage>;
    items: Map<string, AgentMessage>;
  };
  // One task per conversation key in this backend’s configured workspace.
  const tasks = new Map<string, Active>();
  const run: Backend = async (mode, prompt, key, signal, sender, attachments = [], interact, publish, hooks) => {
    const config = { ...(typeof configuration === 'function' ? configuration() : configuration) };
    signal.throwIfAborted();
    if (mode !== 'codex') throw new Error('Manager requests must use the manager handler.');
    if (tasks.has(key)) throw new PublicError('A task is already running in this conversation.');
    const current: Active = { key, sender, signal, ended: false, ready: deferred<void>(), done: deferred<Turn>(), steering: new Set(), messages: new Map(), items: new Map() };
    tasks.set(key, current);
    const abort = () => {
      if (current.threadId && current.turnId && !current.ended) {
        void current.server?.request('turn/interrupt', { threadId: current.threadId, turnId: current.turnId }).catch(() => {});
      }
      current.done.reject(signal.reason);
      // Closing also cancels startup/steer requests. Keep the task registered until exit.
      void current.server?.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    let progress = Promise.resolve();
    const sentProgress = new Set<string>();
    const compactions = compactionNotices(hooks?.compaction);
    let background: Awaited<ReturnType<typeof startBackgroundMcp>> | undefined;
    let publication: Awaited<ReturnType<typeof startPublishMcp>> | undefined;
    let media: Awaited<ReturnType<typeof startAttachmentMcp>> | undefined;
    let rooms: Awaited<ReturnType<typeof startRoomMessageMcp>> | undefined;
    let web: Awaited<ReturnType<typeof startFetchMcp>> | undefined;
    let delivery: ReturnType<typeof attachmentDelivery> | undefined;
    const mediaLifetime = new AbortController();
    try {
      if (hooks?.background) background = await startBackgroundMcp(hooks.background, signal);
      if (hooks?.roomMessages) rooms = await startRoomMessageMcp(hooks.roomMessages, AbortSignal.any([signal, mediaLifetime.signal]));
      // The tool writes response files into the workspace, so a read-only bot does not get it.
      if (config.fetch && config.sandbox !== 'read-only') web = await startFetchMcp(fetchAction(config.fetch, config.workspace), AbortSignal.any([signal, mediaLifetime.signal]));
      if (publish && interact && config.sandbox !== 'read-only') publication = await startPublishMcp(publish, signal);
      const outbox = await outboxDirectory(config.workspace, key);
      if (hooks?.sendAttachments) {
        delivery = attachmentDelivery(outbox, config.maxMediaBytes, async (files, callSignal) => {
          await progress;
          callSignal.throwIfAborted();
          return hooks.sendAttachments!(files, callSignal);
        });
        media = await startAttachmentMcp(delivery.action, AbortSignal.any([signal, mediaLifetime.signal]));
      }
      signal.throwIfAborted();
      const server = current.server = new AppServer(config, notification => {
        const p = notification.params;
        if (p?.threadId !== current.threadId) return;
        if (notification.method === 'turn/started' && p.turn) current.turnId = p.turn.id;
        if (!current.ended && p.turnId === current.turnId && p.item?.type === 'contextCompaction') {
          if (notification.method === 'item/started') compactions.start(p.item.id);
          if (notification.method === 'item/completed') compactions.complete(p.item.id);
        }
        if ((notification.method === 'item/started' || notification.method === 'item/completed') && p.turnId === current.turnId && p.item) current.items.set(p.item.id, p.item);
        if (notification.method === 'item/completed' && p.turnId === current.turnId && p.item?.type === 'agentMessage') current.messages.set(p.item.id, p.item);
        if (!current.ended && notification.method === 'item/completed' && p.turnId === current.turnId && p.item?.type === 'agentMessage' &&
          p.item.phase === 'commentary' && p.item.text && hooks?.progress && !sentProgress.has(p.item.id)) {
          sentProgress.add(p.item.id);
          const text = p.item.text;
          progress = progress.then(() => hooks.progress!(text));
          void progress.catch(error => current.done.reject(error));
        }
        if (notification.method === 'turn/completed' && p.turn && (!current.turnId || p.turn.id === current.turnId)) {
          mediaLifetime.abort();
          current.turnId = p.turn.id; current.ended = true; current.done.resolve(p.turn);
        }
      }, error => current.done.reject(error), interact ? async (request, requestSignal) => {
        const p = request.params;
        if (current.ended || !current.threadId || !current.turnId || p.threadId !== current.threadId || (p.turnId != null && p.turnId !== current.turnId)) return undefined;
        if (p.turnId == null && request.method !== 'mcpServer/elicitation/request') return undefined;
        if (config.codexApprovalPolicy === 'never' && request.method.endsWith('/requestApproval')) return undefined;
        const question = codexInteraction(request, current.items.get(p.itemId), sender === config.owner);
        if (!question) return undefined;
        return interact(question, AbortSignal.any([signal, requestSignal]));
      } : undefined);
      await server.initialize();
      const account = await server.request<{ account: { type: string } | null }>('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') throw new PublicError('Sign in to Codex with your ChatGPT account on the host (codex login). API-key authentication is not supported.');
      signal.throwIfAborted();
      if (!attachments.length && /^!plugin(?:\s|$)/.test(prompt)) {
        if (sender !== config.owner) throw new PublicError('Only the initial owner can install shared Codex plugins.');
        const match = /^!plugin install ([a-z0-9][a-z0-9-]*)(?:@openai-curated-remote)?$/.exec(prompt);
        if (!match || !interact) throw new PublicError('Use !plugin install NAME in an encrypted DM with a Codex bot.');
        current.ready.resolve();
        return await installPlugin(server, match[1], signal, interact);
      }
      const session = state.session(key);
      const saved = session.codex;
      const instructions = routingInstructions + mediaInstructions(outbox, config.maxMediaBytes, !!media) + approvalInstructions('codex') + (publication ? publicationInstructions : '') + (background ? backgroundInstructions : '') + (rooms ? roomMessageInstructions : '')
        + (web && config.fetch ? fetchInstructions(config.fetch.allow.map(p => p.text)) : '');
      const instructionsHash = createHash('sha256').update(instructions).digest('hex');
      const options = {
        cwd: config.workspace, sandbox: config.sandbox, approvalPolicy: interact ? config.codexApprovalPolicy : 'never', approvalsReviewer: 'user', modelProvider: 'openai', model: config.codexModel,
        serviceTier: config.codexServiceTier,
        // New threads need their initial developer message. Resumed threads already
        // contain it; changed instructions are persisted explicitly below.
        ...(!saved && { developerInstructions: instructions }),
        config: { forced_login_method: 'chatgpt', model_provider: 'openai', 'sandbox_workspace_write.network_access': false, web_search: 'disabled',
          [`mcp_servers.${PUBLISH_SERVER}`]: publication ? { url: publication.url, http_headers: publication.headers,
            required: true, enabled: true, tool_timeout_sec: Math.ceil(config.timeoutMs / 1000), enabled_tools: ['prepare_publish'],
            // Invoking this tool starts the review; requestPublish itself requires Matrix
            // approval after delivering the HTML. Avoid an empty MCP consent form first.
            tools: { prepare_publish: { approval_mode: 'approve' } },
          } : disabledMcp,
          [`mcp_servers.${BACKGROUND_SERVER}`]: background ? { url: background.url, http_headers: background.headers,
            required: true, enabled: true, enabled_tools: ['background_tasks'],
            tools: { background_tasks: { approval_mode: 'approve' } },
          } : disabledMcp,
          [`mcp_servers.${ATTACHMENT_SERVER}`]: media ? { url: media.url, http_headers: media.headers,
            required: true, enabled: true, tool_timeout_sec: Math.ceil(config.timeoutMs / 1000), enabled_tools: ['send_attachments'],
            tools: { send_attachments: { approval_mode: 'approve' } },
          } : disabledMcp,
          ...(config.codexReasoningEffort ? { model_reasoning_effort: config.codexReasoningEffort } : {}),
          [`mcp_servers.${ROOM_MESSAGE_SERVER}`]: rooms ? { url: rooms.url, http_headers: rooms.headers,
            required: true, enabled: true, tool_timeout_sec: Math.ceil(config.timeoutMs / 1000), enabled_tools: ['room_messages'],
            tools: { room_messages: { approval_mode: 'approve' } },
          } : disabledMcp,
          // Read-only GET under human-configured URL prefixes; no approval needed.
          [`mcp_servers.${FETCH_SERVER}`]: web ? { url: web.url, http_headers: web.headers,
            required: true, enabled: true, enabled_tools: ['fetch'],
            tools: { fetch: { approval_mode: 'approve' } },
          } : disabledMcp,
        },
      };
      const thread = await server.request<{ thread: { id: string }; model?: string; reasoningEffort?: string | null; serviceTier?: string | null; cwd?: string }>(saved ? 'thread/resume' : 'thread/start', saved ? { ...options, threadId: saved, excludeTurns: true } : options);
      if (saved && thread.thread.id !== saved) throw new PublicError('Codex resumed a different session. The saved history was not replaced.');
      current.threadId = thread.thread.id;
      state.update(key, { codex: current.threadId, codexReport: engineReport(thread) });
      signal.throwIfAborted();
      // Resume options do not replace developer messages already in model-visible history.
      // Persist a new message only when the connector instructions have changed.
      if (saved && session.codexInstructionsHash !== instructionsHash) {
        await server.request('thread/inject_items', {
          threadId: current.threadId,
          items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text',
            text: 'Updated Matrix connector instructions. These supersede earlier Matrix connector instructions.\n' + instructions }] }],
        });
        signal.throwIfAborted();
      }
      const started = await server.request<{ turn: Turn }>('turn/start', {
        threadId: current.threadId, input: input(prompt, attachments),
        // Explicit settings also override values persisted in resumed threads.
        model: config.codexModel, effort: config.codexReasoningEffort, serviceTier: config.codexServiceTier,
      });
      state.update(key, { codexInstructionsHash: instructionsHash });
      current.turnId = started.turn.id;
      if (started.turn.status !== 'inProgress') { current.ended = true; current.done.resolve(started.turn); }
      current.ready.resolve();
      const completed = await current.done.promise;
      await progress;
      signal.throwIfAborted();
      if (completed.status !== 'completed') throw new PublicError(completed.status === 'interrupted' ? 'Codex task was interrupted.' : 'Codex task failed. Please retry.');
      for (const item of completed.items || []) if (item.type === 'agentMessage') current.messages.set(item.id, item);
      const messages = [...current.messages.values()].filter(item => item.phase !== 'commentary');
      const reply = parseMediaReply(messages.at(-1)?.text || '', outbox);
      return delivery ? delivery.final(reply) : reply;
    } finally {
      current.ended = true;
      await compactions.close();
      mediaLifetime.abort();
      await media?.close();
      await rooms?.close();
      await web?.close();
      await progress.catch(() => {});
      await background?.close(); await publication?.close();
      current.ready.resolve();
      await Promise.allSettled([...current.steering]);
      await current.server?.close();
      signal.removeEventListener('abort', abort);
      if (tasks.get(key) === current) tasks.delete(key);
    }
  };

  const steer: Steer = async (prompt, key, signal, sender, attachments = []) => {
    const current = tasks.get(key);
    if (!current || current.key !== key || current.sender !== sender) return false;
    await current.ready.promise;
    signal.throwIfAborted(); current.signal.throwIfAborted();
    if (tasks.get(key) !== current || current.ended || !current.turnId || !current.threadId || !current.server) return false;
    const request = (async () => {
      try {
        const result = await current.server!.request<{ turnId: string }>('turn/steer', {
          threadId: current.threadId, expectedTurnId: current.turnId, input: input(prompt, attachments),
        });
        if (result.turnId !== current.turnId) throw new Error('Unexpected steering turn ID.');
        return true;
      } catch (error) {
        signal.throwIfAborted();
        if (current.ended && error instanceof RpcError) return false;
        throw error;
      }
    })();
    current.steering.add(request);
    try { return await request; } finally { current.steering.delete(request); }
  };
  return Object.assign(run, { steer });
}
