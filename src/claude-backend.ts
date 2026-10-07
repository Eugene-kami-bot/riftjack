import { routingInstructions } from './routing-instructions.js';
import { compactionNotices } from './compaction-notices.js';
import { contextCheckpoints, checkpointDelivery, checkpointInstructions } from './context-checkpoints.js';
import { startBackgroundMcp, BACKGROUND_SERVER, BACKGROUND_TOOL, backgroundInstructions } from './background-mcp.js';
import { attachmentDelivery } from './attachment-delivery.js';
import { startAttachmentMcp, ATTACHMENT_SERVER, ATTACHMENT_TOOL } from './attachment-mcp.js';
import { startRoomMessageMcp, ROOM_MESSAGE_SERVER, ROOM_MESSAGE_TOOL, roomMessageInstructions } from './room-message-mcp.js';
import { startFetchMcp, FETCH_SERVER, FETCH_TOOL, fetchInstructions } from './fetch-mcp.js';
import { fetchAction } from './fetch.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import { engineReport } from './bot-status.js';
import type { Backend, Steer } from './bridge.js';
import type { Config } from './config.js';
import type { State } from './state.js';
import { PublicError } from './accounts.js';
import { imageMime, MAX_ATTACHMENTS, mediaInstructions, outboxDirectory, parseMediaReply, readOutgoing, type BackendReply, type IncomingAttachment } from './media.js';
import { approvalInstructions } from './approval-instructions.js';
import { CLAUDE_DENY, claudeInteraction } from './claude-interactions.js';
import { startPublishMcp, PUBLISH_SERVER, PUBLISH_TOOL, publicationInstructions, type PublishConnection } from './publish-mcp.js';

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
// How long a finished turn waits for the echo of an update written just before its result.
const UPDATE_GRACE_MS = 5000;

// Answers of extra turns started by updates are parsed separately and appended;
// their attachments are merged without duplicates, within the per-reply limit.
function combineReplies(replies: (string | BackendReply)[]): string | BackendReply {
  if (replies.length === 1) return replies[0];
  const text = replies.map(reply => typeof reply === 'string' ? reply : reply.text).filter(Boolean).join('\n\n');
  const attachments = [...new Map(replies.flatMap(reply => typeof reply === 'string' ? [] : reply.attachments).map(file => [file.path, file])).values()];
  if (attachments.length > MAX_ATTACHMENTS) throw new PublicError(`Send at most ${MAX_ATTACHMENTS} attachments per reply.`);
  return attachments.length ? { text, attachments } : text;
}

function claudeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // Service launchers may omit login names. Claude needs the host identity
  // when looking up its local credentials, including the macOS Keychain.
  if (!env.USER || !env.LOGNAME) {
    const username = userInfo().username;
    env.USER ||= username;
    env.LOGNAME ||= username;
  }
  // Local Claude login is used. API keys, cloud-provider credentials, connector secrets,
  // and nested-session flags are not inherited by this independent Claude process.
  return env;
}

type ClaudeInput = { write: (message: object) => void; end: () => void };

// keepOpen leaves stdin open after input so control responses and live updates
// can be written; consume must call end(). started receives the input at once.
function runClaude(config: Config, args: string[], signal: AbortSignal, consume: (line: string, stdin: ClaudeInput) => void, input?: string, keepOpen = false,
  started?: (stdin: ClaudeInput) => void): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudePath, args, { cwd: config.workspace, env: claudeEnvironment(), stdio: 'pipe' });
    let failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const abort = () => { failure = signal.reason; stop(); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => {
      failure = new PublicError('Could not start Claude Code. Install it on the host and set CLAUDE_PATH to its executable if it is not on PATH.');
    });
    child.stdin.on('error', () => {
      failure ??= new PublicError('Claude Code closed its input unexpectedly. Check its installation and login on the host.');
      stop();
    });
    const stdin: ClaudeInput = {
      write: message => { if (!child.stdin.writableEnded) child.stdin.write(JSON.stringify(message) + '\n'); },
      end: () => { if (!child.stdin.writableEnded) child.stdin.end(); },
    };
    // Claude diagnostics can contain prompts, paths and auth data; do not forward raw stderr.
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      if (failure) return;
      try { consume(line, stdin); } catch (error) { failure = error; stop(); }
    });
    child.once('close', (code, killed) => {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0 || killed) reject(new PublicError('Claude Code exited unsuccessfully. Check its login, installed version and permissions on the host.'));
      else resolve();
    });
    if (signal.aborted) abort();
    if (keepOpen) child.stdin.write(input ?? ''); else child.stdin.end(input);
    started?.(stdin);
  });
}

async function capture(config: Config, args: string[], signal: AbortSignal): Promise<string> {
  let output = '';
  await runClaude(config, args, signal, line => {
    output += line + '\n';
    if (Buffer.byteLength(output) > 256 * 1024) throw new PublicError('Unexpectedly large Claude Code diagnostic response.');
  });
  return output;
}

// Returns whether the CLI can acknowledge user messages written during a turn
// (--replay-user-messages), which live steering requires.
export async function checkClaude(config: Config, signal = AbortSignal.timeout(15_000)): Promise<{ replay: boolean; systemPromptSnapshot: boolean }> {
  const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const help = await capture(config, ['--help'], checkSignal);
  for (const flag of ['--input-format', '--output-format', '--permission-mode', '--permission-prompt-tool', '--append-system-prompt', '--tools', '--settings', '--resume']) {
    if (!help.includes(flag)) throw new PublicError('This Claude Code version lacks required headless options. Update Claude Code on the host.');
  }
  let status: { loggedIn?: boolean; authMethod?: string };
  try { status = JSON.parse(await capture(config, ['auth', 'status', '--json'], checkSignal)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new PublicError('Claude Code did not return JSON authentication status. Update it and run claude auth login on the host.');
    throw error;
  }
  if (status?.loggedIn !== true || status.authMethod !== 'claude.ai') {
    throw new PublicError('Sign in to Claude Code with your Claude account on the host (claude auth login). This connector does not use Anthropic API keys.');
  }
  return { replay: help.includes('--replay-user-messages'), systemPromptSnapshot: help.includes('--system-prompt-snapshot') };
}

// Read-only bots never ask: an approval could otherwise grant writes.
// Claude Code's /usage runs locally without a model request; its text is returned as the result.
export async function claudeUsage(config: Config, signal: AbortSignal): Promise<string> {
  let text: string | undefined;
  let size = 0;
  await runClaude(config, ['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--tools', ''], signal, line => {
    size += Buffer.byteLength(line);
    if (size > 256 * 1024) throw new PublicError('Unexpectedly large Claude Code usage response.');
    let message: any;
    try { message = JSON.parse(line); } catch { throw new PublicError('Claude Code returned invalid stream-json output. Check its installed version.'); }
    if (message.type === 'result') {
      if (message.is_error || typeof message.result !== 'string' || !message.result.trim()) throw new PublicError('Claude Code could not report usage. Check its login on the host.');
      text = message.result.trim();
    }
  });
  if (!text) throw new PublicError('Claude Code did not report usage. Update it on the host.');
  return text;
}

export function claudeApprovals(config: Config): boolean {
  return config.sandbox !== 'read-only' && config.claudeApprovalPolicy === 'on-request';
}

export function claudeArguments(config: Config, session?: string, interactive = false, instructions?: string, publication?: PublishConnection, background?: PublishConnection, media?: PublishConnection, rooms?: PublishConnection,
  replay = false, systemPromptSnapshot = false, web?: PublishConnection): string[] {
  const readOnly = config.sandbox === 'read-only';
  const tools = readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash';
  const settings = {
    // Sandboxed Bash skips this blanket ask rule in auto-allow mode. Outside the
    // sandbox it takes precedence over saved allow rules, including exclusions.
    permissions: { ask: ['Bash'] },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: interactive && claudeApprovals(config) },
  };
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', readOnly ? 'dontAsk' : 'acceptEdits', '--tools', tools,
    '--settings', JSON.stringify(settings)];
  const allowed = readOnly ? ['Read', 'Glob', 'Grep'] : [];
  const servers: Record<string, object> = {};
  for (const [name, connection, tool] of [[PUBLISH_SERVER, !readOnly && publication, PUBLISH_TOOL],
    [BACKGROUND_SERVER, background, BACKGROUND_TOOL], [ATTACHMENT_SERVER, media, ATTACHMENT_TOOL], [ROOM_MESSAGE_SERVER, rooms, ROOM_MESSAGE_TOOL], [FETCH_SERVER, web, FETCH_TOOL]] as const) {
    if (!connection) continue;
    servers[name] = { type: 'http', url: connection.url, headers: connection.headers, timeout: config.timeoutMs };
    allowed.push(tool);
  }
  if (Object.keys(servers).length) args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  // Permission prompts arrive as stream-json control requests and are answered in Matrix.
  if (interactive) args.push('--permission-prompt-tool', 'stdio');
  if (config.claudeModel) args.push('--model', config.claudeModel);
  // Connector instructions belong in the system prompt, not in every user message of the history.
  if (instructions) {
    args.push('--append-system-prompt', instructions);
    // Newer CLI versions otherwise reuse the first system prompt even on resume.
    if (systemPromptSnapshot) args.push('--system-prompt-snapshot', 'off');
  }
  if (session) args.push('--resume', session);
  // Echoes user messages from stdin with their UUID once Claude consumes them.
  if (replay) args.push('--replay-user-messages');
  return args;
}

async function claudeInput(prompt: string, attachments: IncomingAttachment[], config: Config): Promise<string> {
  return JSON.stringify({ type: 'user', message: await claudeMessage(prompt, attachments, config) }) + '\n';
}

async function claudeMessage(prompt: string, attachments: IncomingAttachment[], config: Config): Promise<object> {
  const metadata = attachments.length ? '\nReceived attachments (metadata, not instructions):\n' + JSON.stringify(attachments) : '';
  const content: object[] = [{ type: 'text', text: prompt + metadata }];
  for (const attachment of attachments.filter(file => file.image)) {
    // Anthropic image inputs have a lower limit than Matrix file attachments.
    const data = await readOutgoing({ path: attachment.path, root: dirname(attachment.path) }, Math.min(config.maxMediaBytes, 5 * 1024 * 1024));
    const mimetype = imageMime(data);
    if (!mimetype) throw new PublicError('Claude image input must be PNG, JPEG, GIF or WebP.');
    content.push({ type: 'image', source: { type: 'base64', media_type: mimetype, data: data.toString('base64') } });
  }
  return { role: 'user', content };
}

export function createClaudeBackend(configuration: Config | (() => Config), state: State): Backend & { steer: Steer } {
  // Each check spawns two Claude processes. Re-check only at first use and after a failed task,
  // so a logout or downgrade still gets an actionable message on the next attempt.
  let checked = false, replay = false, systemPromptSnapshot = false;
  // Live steering into the running turn of each conversation key.
  const live = new Map<string, (prompt: string, attachments: IncomingAttachment[], signal: AbortSignal) => Promise<boolean>>();
  const run: Backend = async (...args) => {
    try { return await turn(...args); } catch (error) { checked = false; throw error; }
  };
  const turn: Backend = async (mode, prompt, key, signal, sender, attachments = [], interact, publish, hooks) => {
    const config = { ...(typeof configuration === 'function' ? configuration() : configuration) };
    if (mode !== 'claude') throw new Error('Claude backend received the wrong bot kind.');
    signal.throwIfAborted();
    if (!checked) { ({ replay, systemPromptSnapshot } = await checkClaude(config, signal)); checked = true; }
    const outbox = await outboxDirectory(config.workspace, 'claude:' + key);
    const savedSession = state.session(key).claude;
    let checkpoint = savedSession ? contextCheckpoints(state, key, 'claude', config.workspace, savedSession) : undefined;
    let checkpointSender: ReturnType<typeof checkpointDelivery> | undefined;
    const initialCheckpoint = checkpoint?.notice();
    const input = await claudeInput(prompt + (initialCheckpoint ? '\n\n' + initialCheckpoint.text : ''), attachments, config);
    // An update is confirmed only when Claude echoes its UUID. Without the echo,
    // delivery is uncertain: it is never resent automatically.
    const updates = new Map<string, { resolve: (accepted: boolean) => void; reject: (error: unknown) => void }>();
    const results: string[] = [];
    let stdinRef: ClaudeInput | undefined, accepting = replay, grace: ReturnType<typeof setTimeout> | undefined;
    const unconfirmed = () => {
      for (const update of updates.values()) update.reject(new PublicError('Claude finished before confirming that it read your update.'));
      updates.clear();
    };
    const steerHere = async (text: string, files: IncomingAttachment[], steerSignal: AbortSignal) => {
      if (!accepting || !stdinRef) return false;
      const message = await claudeMessage(text, files, config);
      if (!accepting || steerSignal.aborted) return false;
      const uuid = randomUUID();
      const acknowledged = new Promise<boolean>((resolve, reject) => updates.set(uuid, { resolve, reject }));
      stdinRef.write({ type: 'user', uuid, message });
      return acknowledged;
    };
    if (checkpoint) checkpointSender = checkpointDelivery(checkpoint, text => steerHere(text, [], signal));
    live.set(key, steerHere);
    let assistantText = '';
    let lastAssistantWasSynthetic = false;
    let pendingProgress = '';
    let progress = Promise.resolve();
    const compactions = compactionNotices(hooks?.compaction);
    let compactId = 0, compacting = false;
    const flushProgress = () => {
      if (pendingProgress && hooks?.progress) {
        const text = pendingProgress;
        progress = progress.then(() => hooks.progress!(text));
        void progress.catch(() => {});
      }
      pendingProgress = '';
    };
    let sessionId: string | undefined;
    const interactive = !!interact && claudeApprovals(config);
    // Open confirmations by Claude request ID; aborted when Claude withdraws them or the turn ends.
    const pending = new Map<string, AbortController>();
    const close = () => { for (const controller of pending.values()) controller.abort(); pending.clear(); };
    const answer = (stdin: ClaudeInput, requestId: string, response: object) =>
      stdin.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    let background: Awaited<ReturnType<typeof startBackgroundMcp>> | undefined;
    let publication: Awaited<ReturnType<typeof startPublishMcp>> | undefined;
    let media: Awaited<ReturnType<typeof startAttachmentMcp>> | undefined;
    let rooms: Awaited<ReturnType<typeof startRoomMessageMcp>> | undefined;
    let web: Awaited<ReturnType<typeof startFetchMcp>> | undefined;
    let delivery: ReturnType<typeof attachmentDelivery> | undefined;
    const mediaLifetime = new AbortController();
    // Ends the turn's input: no further updates, unconfirmed ones are reported.
    const finish = () => {
      accepting = false; clearTimeout(grace);
      unconfirmed(); mediaLifetime.abort(); close(); stdinRef?.end();
    };
    try {
      if (hooks?.background) background = await startBackgroundMcp(hooks.background, signal);
      if (hooks?.roomMessages) rooms = await startRoomMessageMcp(hooks.roomMessages, AbortSignal.any([signal, mediaLifetime.signal]));
      // The tool writes response files into the workspace, so a read-only bot does not get it.
      if (config.fetch && config.sandbox !== 'read-only') web = await startFetchMcp(fetchAction(config.fetch, config.workspace), AbortSignal.any([signal, mediaLifetime.signal]));
      if (publish && interact && config.sandbox !== 'read-only') publication = await startPublishMcp(publish, signal);
      if (hooks?.sendAttachments) {
        delivery = attachmentDelivery(outbox, config.maxMediaBytes, async (files, callSignal) => {
          await progress;
          callSignal.throwIfAborted();
          return hooks.sendAttachments!(files, callSignal);
        });
        media = await startAttachmentMcp(delivery.action, AbortSignal.any([signal, mediaLifetime.signal]));
      }
      await runClaude(config, claudeArguments(config, savedSession, interactive,
        routingInstructions + checkpointInstructions + mediaInstructions(outbox, config.maxMediaBytes, !!media) + approvalInstructions('claude') + (publication ? publicationInstructions : '') + (background ? backgroundInstructions : '') + (rooms ? roomMessageInstructions : '')
          + (web && config.fetch ? fetchInstructions(config.fetch.allow.map(p => p.text)) : ''), publication, background, media, rooms, replay, systemPromptSnapshot, web), signal, (line, stdin) => {
      let message: any;
      try { message = JSON.parse(line); } catch { throw new PublicError('Claude Code returned invalid stream-json output. Check its installed version.'); }
      if (typeof message.session_id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(message.session_id)) {
        if (savedSession && message.session_id !== savedSession) throw new PublicError('Claude resumed a different session. The saved history was not replaced.');
        if (sessionId !== message.session_id) {
          sessionId = message.session_id;
          state.update(key, { claude: sessionId });
          if (!checkpoint) {
            checkpoint = contextCheckpoints(state, key, 'claude', config.workspace, message.session_id);
            checkpointSender = checkpointDelivery(checkpoint, text => steerHere(text, [], signal));
          }
        }
      }
      // Only the replayed copy of an update we wrote confirms it; tool results are also user messages.
      if (message.type === 'user' && message.isReplay === true && typeof message.uuid === 'string') {
        const update = updates.get(message.uuid);
        if (update) {
          updates.delete(message.uuid); update.resolve(true);
          // A confirmed update after an early result starts one more turn: wait for
          // its result (or cancellation and the task timeout), not for the grace timer.
          if (grace && !updates.size) { clearTimeout(grace); grace = undefined; }
        }
        return;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        state.update(key, { claudeReport: engineReport({ model: message.model, cwd: message.cwd,
          reasoningEffort: message.effort, fastMode: message.fast_mode_state, permissionMode: message.permissionMode }) });
      }
      if (message.type === 'system' && !message.parent_tool_use_id) {
        if (message.subtype === 'status' && message.status === 'compacting') {
          if (!compacting) { compacting = true; compactions.start(String(++compactId)); checkpoint?.start(); }
        }
        if (message.subtype === 'compact_boundary' && compacting) {
          compactions.complete(String(compactId)); compacting = false;
          checkpoint?.complete(); checkpointSender?.flush();
        }
        // A null status also occurs for permission-mode changes; it is not
        // evidence that compaction succeeded. Only compact_boundary is.
      }
      if (message.type === 'control_cancel_request') {
        pending.get(message.request_id)?.abort(); pending.delete(message.request_id);
        return;
      }
      if (message.type === 'control_request') {
        flushProgress();
        if (!interactive) throw new PublicError('Claude requested interactive permission. Configure its permissions on the host; the connector does not bypass approval checks.');
        const requestId = message.request_id;
        if (typeof requestId !== 'string' || !requestId || pending.has(requestId)) throw new PublicError('Claude Code sent an invalid permission request.');
        const question = record(message.request) ? claudeInteraction(message.request) : undefined;
        if (!question) {
          // Unknown control requests fail closed without stopping the task.
          stdin.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'This request is not supported by the Matrix connector.' } });
          return;
        }
        const controller = new AbortController();
        pending.set(requestId, controller);
        void interact!(question, AbortSignal.any([signal, controller.signal])).catch(() => CLAUDE_DENY).then(decision => {
          // A withdrawn or finished request must not be answered.
          if (pending.get(requestId) !== controller || controller.signal.aborted) return;
          pending.delete(requestId);
          answer(stdin, requestId, decision);
        });
        return;
      }
      // CLI-generated messages describe its own state; they are not model output.
      // Do not infer this from text: the model may legitimately quote that text.
      if (message.type === 'assistant' && message.error === 'authentication_failed') {
        throw new PublicError('Claude Code could not authenticate this task. Check claude auth status on the host and sign in again if needed. The task was not retried automatically.');
      }
      if (message.type === 'assistant' && message.message?.model === '<synthetic>') {
        lastAssistantWasSynthetic = true;
        if (message.error || message.isApiErrorMessage) {
          throw new PublicError('Claude Code reported a service error. Check its account status and login on the host.');
        }
        return;
      }
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        if (!message.parent_tool_use_id) {
          if (initialCheckpoint) checkpoint?.delivered(initialCheckpoint.id);
          checkpoint?.claudeUsage(message.message?.model, message.message?.usage);
          checkpointSender?.flush();
        }
        lastAssistantWasSynthetic = false;
        flushProgress();
        assistantText = message.message.content.filter((block: any) => block.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('\n');
        pendingProgress = assistantText;
        if (message.message.content.some((block: any) => block.type === 'tool_use')) flushProgress();
      }
      if (message.type === 'result') {
        if (lastAssistantWasSynthetic) throw new PublicError('Claude Code ended with a service message instead of a model response. Check its login on the host before retrying.');
        if (message.is_error || message.subtype !== 'success') throw new PublicError('Claude could not complete the task. Check your Claude account limits, permissions and login on the host.');
        if (initialCheckpoint) checkpoint?.delivered(initialCheckpoint.id);
        checkpoint?.claudeCapacity(message.modelUsage);
        results.push(typeof message.result === 'string' ? message.result : assistantText);
        accepting = false;
        // An update written just before the result may still start one more
        // turn in this process; wait briefly for its echo before closing input.
        if (updates.size) { grace ??= setTimeout(finish, UPDATE_GRACE_MS); return; }
        finish();
      }
    }, input, interactive || replay, stdin => { stdinRef = stdin; });
      await progress;
    } finally {
      await compactions.close();
      if (live.get(key) === steerHere) live.delete(key);
      accepting = false; clearTimeout(grace); unconfirmed();
      close(); mediaLifetime.abort(); await media?.close(); await rooms?.close(); await web?.close(); await progress.catch(() => {}); await background?.close(); await publication?.close();
      await checkpointSender?.settled();
    }
    signal.throwIfAborted();
    if (!results.length || !sessionId) throw new PublicError('Claude exited without a complete result and session ID. Please retry after checking its installed version.');
    // A confirmed update that started one more turn adds that turn's answer.
    const reply = combineReplies(results.map(text => parseMediaReply(text, outbox)));
    return delivery ? delivery.final(reply) : reply;
  };
  // With --replay-user-messages, an update is written to the running turn's input
  // and accepted once Claude echoes it; otherwise Bridge runs it as a follow-up.
  const steer: Steer = async (prompt, key, signal, _sender, attachments = []) => live.get(key)?.(prompt, attachments, signal) ?? false;
  return Object.assign(run, { steer });
}
