import { linkedRoomMessages } from './room-messages.js';
import { sendCompactionNotice } from './compaction-notices.js';
import { sendOwnerDiagnostic } from './owner-diagnostics.js';
import { withEngineSettings } from './engine-settings.js';
import { parseBotSettingsRequest, manageBotSettings } from './bot-settings.js';
import { BackgroundTasks } from './background-tasks.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { InstanceBusyError, lockInstance } from './instance-lock.js';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { botStatus } from './bot-status.js';
import { requestPublish } from './publish.js';
import { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider, LogService, LogLevel } from '@vector-im/matrix-bot-sdk';
import { StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { loadConfig, type Config } from './config.js';
import { State } from './state.js';
import { WorkerBridge } from './worker-bridge.js';
import { WorkerMatrixClient } from './worker-matrix-client.js';
import { WorkerQueue } from './worker-queue.js';
import { WorkerService } from './worker-service.js';
import { WorkerServer } from './worker-server.js';
import { Bridge, SERVICE, type MatrixEvent } from './bridge.js';
import { replyContent } from './message-format.js';
import { inlineCode, markdownText, managerBotList } from './manager-format.js';
import { createMatrixUser, parseUserCreation } from './matrix-users.js';
import { isPrivateRoom } from './private-room.js';
import { ConversationLinks, mentionText } from './conversation-links.js';
import { sendConfirmation } from './confirmation-message.js';
import { createBackend } from './backends.js';
import { Accounts, parseManagerRequest, provision, PublicError, type Account } from './accounts.js';
import { errorMessage, safeErrorSummary } from './errors.js';
import { Access, parseAccessRequest } from './access.js';
import { manageBotAccess, parseBotAccessRequest } from './bot-access.js';
import { BotInvitations } from './bot-invitations.js';
import { MatrixMedia } from './media.js';
import { AudioTranscriber } from './audio-transcription.js';
import { AudioConfigurationWarnings } from './audio-notice.js';
import { CONFIG_EXIT_CODE, RestartController } from './restart.js';
import { RestartNotice } from './restart-notice.js';
import { checkClaude, claudeUsage } from './claude-backend.js';
import { formatClaudeUsage } from './claude-usage.js';
import { codexUsage } from './codex-usage.js';
import { SshTunnel } from './ssh-tunnel.js';
import { ensureDeviceIdentity } from './device-identity.js';
import { configForWorkspace, creationWorkspace } from './workspace.js';
import { MANAGER_HELP } from './manager-help.js';
import { resolveProfileTarget, parseProfileRequest, updateBotProfile } from './bot-profile.js';
import type { SupervisorMessage } from './supervisor.js';

process.umask(0o077);
// The supervisor's IPC channel must not keep a failed connector alive.
process.channel?.unref();
const notifySupervisor = (message: SupervisorMessage) => { process.send?.(message, undefined, undefined, () => {}); };
let tunnel: SshTunnel | undefined;

function diagnostics(error: unknown, bot?: string) {
  console.error(JSON.stringify({ time: new Date().toISOString(), event: 'connector-error', bot, message: errorMessage(error) }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--check-config', '--check-claude', '--bootstrap-codex', '--bootstrap-claude', '--bootstrap-grok'].includes(arg))) {
    console.error('Use no arguments to start, or one of: --check-config, --check-claude, --bootstrap-codex, --bootstrap-claude, --bootstrap-grok.');
    process.exitCode = CONFIG_EXIT_CODE;
    return;
  }
  let config: Config;
  try { config = loadConfig(); } catch (error) { console.error((error as Error).message); process.exitCode = CONFIG_EXIT_CODE; return; }
  notifySupervisor({ type: 'connector-config', dataDir: config.dataDir });
  if (process.argv.includes('--check-config')) {
    if (config.audioTranscriptionWarning) console.warn(config.audioTranscriptionWarning);
    console.log('Configuration is valid. No network requests were made.'); return;
  }
  if (process.argv.includes('--check-claude')) { await checkClaude(config); console.log('Claude Code supports the required CLI options and reports a Claude account login. No model request was made.'); return; }
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try { lockInstance(config.dataDir); }
  catch (error) {
    // Contention is not a crash: do not retry or roll back the running code.
    if (!(error instanceof InstanceBusyError)) throw error;
    console.error(error.message);
    process.exitCode = CONFIG_EXIT_CODE;
    return;
  }
  if (config.sshTunnel) tunnel = new SshTunnel(config.sshTunnel, { report: message => console.log(message) });
  const accounts = new Accounts(join(config.dataDir, 'accounts.json'));
  const audioWarnings = new AudioConfigurationWarnings();
  let audio = config.audioTranscription ? new AudioTranscriber(config.audioTranscription) : undefined;
  const checkAudio = (candidate: Config) => {
    if (candidate.audioTranscriptionWarning) {
      audio = undefined;
      audioWarnings.add(candidate.audioTranscriptionWarning);
      console.warn(candidate.audioTranscriptionWarning);
    }
  };
  checkAudio(config);
  // Check every saved workspace before any bot can invoke the shared recognizer.
  for (const account of accounts.list()) {
    try { checkAudio(configForWorkspace(config, account.workspace)); }
    catch { /* Invalid workspace is reported by startAccount; unrelated bots can still start. */ }
  }
  const access = new Access(join(config.dataDir, 'allowed-users.json'), config.owner);
  if (process.argv.includes('--bootstrap-codex') || process.argv.includes('--bootstrap-claude') || process.argv.includes('--bootstrap-grok')) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void (tunnel?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
    });
    tunnel?.start();
    try {
      if (process.argv.includes('--bootstrap-grok') && !config.workerPort) throw new PublicError('Set WORKER_PORT before creating Grok bots.');
      const kinds = process.argv.includes('--bootstrap-grok') ? ['manager', 'grok'] as const : process.argv.includes('--bootstrap-claude') ? ['manager', 'claude'] as const : ['manager', 'codex'] as const;
      if (process.argv.includes('--bootstrap-claude')) await checkClaude(config);
      for (const kind of kinds) {
        if (accounts.list().some(a => a.kind === kind)) continue;
        await tunnel?.waitUntilReady();
        const account = await provision(config, kind, kind === 'manager' ? 'Bot Manager' : kind === 'claude' ? 'Claude' : kind === 'grok' ? 'Grok' : 'Codex');
        accounts.add(account);
        console.log('Created ' + kind + ': ' + account.userId);
      }
      console.log('Initial accounts saved. Start the connector to bring them online and receive DM invitations.');
    } finally { await tunnel?.stop(); }
    return;
  }
  if (!accounts.list().length) throw new PublicError('No bot accounts configured. Run bootstrap:codex, bootstrap:claude or bootstrap:grok first (see README).');

  LogService.setLevel(LogLevel.WARN);
  LogService.setLogger({
    info() {}, debug() {}, trace() {},
    warn(module) { console.warn('Matrix SDK warning (' + module + ').'); },
    // SDK arguments can hold tokens and request bodies; only allow-listed codes are printed.
    error(module, ...args) {
      const details = args.map(safeErrorSummary).filter(summary => !summary.startsWith('Error (no safe'));
      // The HTTP layer logs every non-2xx response before callers handle it. M_NOT_FOUND is an
      // expected answer (e.g. a bot has no m.direct account data at startup) and is handled there.
      if (module === 'MatrixHttpClient' && details.length === 1 && details[0] === 'M_NOT_FOUND') return;
      console.error('Matrix SDK error (' + [module, ...new Set(details)].join(', ') + '). Check homeserver connectivity and bot device credentials.');
    },
  });
  const state = new State(join(config.dataDir, 'sessions.json'));
  const links = new ConversationLinks(join(config.dataDir, 'conversation-links.json'),
    join(config.dataDir, 'shared-room-history.json'), accounts.list(), state, access.owner);
  const clients = new Map<string, { client: MatrixClient; bridge: Bridge | WorkerBridge; privateRoom: (room: string, sender: string) => Promise<boolean> }>();
  const workerServer = new WorkerServer();
  const workers = new Map<string, WorkerService>();
  const backgroundPumps = new Map<string, () => Promise<void>>();
  const backgroundTimer = setInterval(() => { for (const pump of backgroundPumps.values()) void pump().catch(diagnostics); }, 2000);
  backgroundTimer.unref();
  const workerTimer = setInterval(() => { for (const worker of workers.values()) void worker.deliver(); }, 2000);
  workerTimer.unref();
  const botInvitations = new BotInvitations(join(config.dataDir, 'bot-dms.json'));
  const restartNotice = new RestartNotice(join(config.dataDir, 'restart-notice.json'));
  let notifyingRestart = false;
  let restartNoticeTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let creating = false;
  let starting = true;
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    clearInterval(restartNoticeTimer);
    clearInterval(workerTimer);
    clearInterval(backgroundTimer);
    for (const { client, bridge } of clients.values()) { bridge.stop(); client.stop(); }
    void Promise.all([tunnel?.stop(), workerServer.stop(), new Promise(resolve => setTimeout(resolve, 1500))])
      .then(() => process.exit(code));
  };
  const restart = new RestartController({
    supported: process.env.MATRIX_CONNECTOR_SUPERVISED === '1',
    supervisorSupported: process.env.MATRIX_CONNECTOR_SUPERVISOR_RESTART === '1',
    busy: () => starting || creating || stopping || notifyingRestart || [...clients.values()].some(({ bridge }) => bridge.busy),
    shutdown, notice: restartNotice,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown(0));
  tunnel?.start();

  async function startAccount(account: Account) {
    if (clients.has(account.userId)) return;
    if (stopping) throw new PublicError('Connector is shutting down. Restart it to bring the new bot online.');
    // Startup phase durations, logged once the bot is online.
    const startedAt = performance.now(), phases: Record<string, number> = {};
    let phaseStart = startedAt;
    const phase = (name: string) => { const now = performance.now(); phases[name] = Math.round(now - phaseStart); phaseStart = now; };
    const botConfig = configForWorkspace(config, account.workspace);
    checkAudio(botConfig);
    const currentConfig = () => withEngineSettings(botConfig, accounts.list().find(a => a.userId === account.userId) ?? account);
    const backend = createBackend(currentConfig, state);
    const dir = join(config.dataDir, 'bots', createHash('sha256').update(account.userId).digest('hex'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const background = account.kind === 'codex' || account.kind === 'claude' ? new BackgroundTasks(join(dir, 'background-tasks.json'), botConfig.workspace) : undefined;
    const storage = new SimpleFsStorageProvider(join(dir, 'matrix.json'));
    const crypto = new RustSdkCryptoStorageProvider(join(dir, 'crypto'), StoreType.Sqlite);
    if (account.kind === 'grok' && !config.workerPort) throw new PublicError('Set WORKER_PORT to enable the Grok worker connection.');
    const client = account.kind === 'grok' ? new WorkerMatrixClient(config.homeserver, account.accessToken, storage, crypto)
      : new MatrixClient(config.homeserver, account.accessToken, storage, crypto);
    const media = new MatrixMedia(client, { workspace: botConfig.workspace, homeserver: config.homeserver,
      accessToken: account.accessToken, maxBytes: config.maxMediaBytes, scope: account.userId,
      uploadTimeoutMs: config.mediaUploadTimeoutMs,
      reportUpload: measurement => console.log(JSON.stringify({ time: new Date().toISOString(), ...measurement })) });
    phase('storage');
    const me = await client.getWhoAmI();
    phase('whoami');
    if (me.user_id !== account.userId || !me.device_id) throw new PublicError('Bot ' + account.userId + ' needs its own device-bound Matrix access token.');
    const authorized = (sender: string) => access.has(sender, account.kind === 'manager' ? undefined : account.userId);
    const linkedAgent = links.agent(account.userId);
    const since = Date.now();
    const privateRoom = async (room: string, sender: string) => linkedAgent
      ? authorized(sender) && await links.allowed(account.userId, room, sender, () => client.getRoomState(room)) && authorized(sender)
      : isPrivateRoom(client, room, account.userId, sender, authorized);
    const reactionTarget = async (room: string, eventId: string): Promise<MatrixEvent | undefined> => {
      try {
        // getEvent returns a RoomEvent wrapper for plaintext targets and a
        // processed raw event after decrypting encrypted targets.
        const target = await client.getEvent(room, eventId);
        return (target.raw ?? target) as MatrixEvent;
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode === 404) return;
        throw error;
      }
    };
    const threadRelation = (event: MatrixEvent) => {
      const relation = event.content?.['m.relates_to'];
      return relation?.rel_type === 'm.thread'
        ? { rel_type: 'm.thread', event_id: relation.event_id }
        : undefined;
    };
    let bridge: Bridge | WorkerBridge;
    if (account.kind === 'grok') {
      const workerDir = join(dir, 'worker');
      const queue = new WorkerQueue(join(workerDir, 'queue.sqlite'));
      const tokenFile = join(workerDir, 'token');
      if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
      const token = readFileSync(tokenFile, 'utf8').trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new PublicError('Invalid Grok worker token file.');
      const service = new WorkerService(queue, join(workerDir, 'uploads'), config.maxMediaBytes, {
        transcribe: (file, signal) => audio ? audio.transcribe(file, signal) : Promise.resolve(file),
        allowed: task => privateRoom(task.room, task.event.sender!),
        receive: task => task.event.content?.file ? media.receive(task.event.content, task.conversation, AbortSignal.timeout(60_000)) : Promise.resolve(undefined),
        prepare: async task => {
          const authorize = async () => {
            if (stopping || !(await privateRoom(task.room, task.event.sender!))) throw new PublicError('Worker reply withheld because access or room privacy changed.');
          };
          const contents: Record<string, unknown>[] = task.response!.text ? replyContent(task.response!.text, true, false, 'm.text') : [];
          for (const file of task.response!.files) contents.push(await media.prepareAttachment({ ...file, root: join(workerDir, 'uploads') }, AbortSignal.timeout(config.mediaUploadTimeoutMs), authorize));
          const encrypted: unknown[] = [];
          for (const content of contents) {
            await authorize();
            encrypted.push(await client.crypto.encryptRoomEvent(task.room, 'm.room.message', { ...content, 'm.relates_to': threadRelation(task.event) }));
          }
          return encrypted;
        },
        send: async (task, transaction, encrypted) => {
          if (stopping || !(await privateRoom(task.room, task.event.sender!))) throw new PublicError('Worker reply withheld because access or room privacy changed.');
          await client.doRequest('PUT', '/_matrix/client/v3/rooms/' + encodeURIComponent(task.room) + '/send/m.room.encrypted/' + encodeURIComponent(transaction), null, encrypted);
        },
        report: diagnostics,
      });
      workers.set(account.userId, service); workerServer.add(account.userId, token, service);
      bridge = new WorkerBridge({ botId: account.userId, authorized, privateRoom, queue, service, state, reactionTarget,
        reply: async (room, event, text) => {
          if (!(await privateRoom(room, event.sender!))) throw new PublicError('Worker control reply withheld.');
          await client.sendMessage(room, { msgtype: 'm.notice', body: text, 'm.relates_to': threadRelation(event) });
        },
      });
      (client as WorkerMatrixClient).inbox = (room, event) => bridge.handle(room, event);
      client.on('worker.inbox_failure', error => { diagnostics(error); shutdown(1); });
      console.log(account.userId + ' worker token file: ' + tokenFile);
    } else bridge = new Bridge({
      botId: me.user_id, isAuthorized: authorized, kind: account.kind, isPrivateRoom: privateRoom, reactionTarget,
      owner: access.owner, isStopping: () => stopping || restart.pending, restart: (reply, target, scope) => restart.request(reply, target, scope),
      steer: backend.steer,
      ownerDiagnostic: (error, { room, sender }) => sendOwnerDiagnostic(error, sender, access.owner,
        linkedAgent?.home ?? room, {
          allowed: target => isPrivateRoom(client, target, account.userId, access.owner, authorized),
          stopping: () => stopping,
          send: (target, content) => client.sendMessage(target, content),
        }),
      compaction: (phase, { room, sender }) => sendCompactionNotice(phase,
        linkedAgent?.home ?? room, {
          // Use the strict two-person check here, not privateRoom which also
          // authorizes linked shared rooms. No fallback to a shared destination.
          allowed: target => isPrivateRoom(client, target, account.userId, sender, authorized),
          stopping: () => stopping,
          send: (target, content) => client.sendMessage(target, content),
        }),
      queuedUpdateMessage: account.kind === 'claude' ? 'Your update is queued for Claude Code in this conversation. It will run after the current step.' : undefined,
      since, timeoutMs: config.timeoutMs, state, report: error => diagnostics(error, account.userId),
      linkedSession: linkedAgent ? (room, event) => links.key(account.userId, room, event) : undefined,
      decoratePrompt: linkedAgent ? (room, event, prompt, steering) => links.prompt(account.userId, room, event, prompt, steering) : undefined,
      promptDelivered: linkedAgent ? () => links.acknowledge(account.userId) : undefined,
      roomMessages: linkedAgent ? (request, context, signal) => linkedRoomMessages(links, account.userId, context, {
        allowed: privateRoom, stopping: () => stopping || restart.pending,
        send: (room, content) => client.sendMessage(room, content),
      })(request, signal) : undefined,
      mentions: linkedAgent ? (room, text) => links.mentions(account.userId, room, text) : undefined,
      shared: linkedAgent ? room => !!links.room(account.userId, room) : undefined,
      // A newly accepted human message to this agent restores its peer credit.
      accepted: linkedAgent ? () => links.credit(account.userId) : undefined,
      publish: (account.kind === 'codex' || account.kind === 'claude') && botConfig.sandbox !== 'read-only'
        ? (input, signal, interact, authorize) => requestPublish(input, botConfig.workspace, botConfig.dataDir, botConfig.maxMediaBytes, signal, interact, authorize) : undefined,
      background: background ? async (input, { room, event, key }, signal) => {
        const session = state.session(key)[account.kind as 'codex' | 'claude'];
        if (!session) throw new PublicError('The agent session is not ready for a background watch.');
        const relation = event.content?.['m.relates_to'];
        return background.action(input, { room, sender: event.sender!, key, session,
          thread: relation?.rel_type === 'm.thread' ? relation.event_id : undefined }, signal);
      } : undefined,
      status: account.kind === 'codex' || account.kind === 'claude'
        ? key => botStatus(account.kind as 'codex' | 'claude', currentConfig(), state.session(key)) + (background?.summary(key, state.session(key)[account.kind as 'codex' | 'claude']) || '') : undefined,
      usage: account.kind === 'claude' ? async signal => formatClaudeUsage(await claudeUsage(botConfig, signal))
        : account.kind === 'codex' ? signal => codexUsage(botConfig, signal) : undefined,
      acceptManagerAvatar: (prompt, sender) => {
        const request = parseProfileRequest(prompt);
        return request?.action === 'avatar' && !!resolveProfileTarget(accounts, request.userId, sender, access.owner);
      },
      async run(mode, prompt, key, signal, sender, attachments, interact, publish, hooks) {
        // Coding bots never interpret account-management commands.
        if (account.kind !== 'manager' || mode !== 'manager') return backend(mode, prompt, key, signal, sender, attachments, interact, publish, hooks);
        const profileRequest = parseProfileRequest(prompt);
        if (profileRequest) return updateBotProfile(profileRequest, {
          accounts, owner: access.owner, sender, signal, attachments: attachments ?? [], maxBytes: config.maxMediaBytes,
          client: userId => clients.get(userId)?.client,
        });
        if (attachments?.length) return 'Use set avatar <bot name> as the image caption.';
        const botAccessRequest = parseBotAccessRequest(prompt);
        if (botAccessRequest) return manageBotAccess(botAccessRequest, {
          accounts, access, sender, signal, revoke: (botId, userId) => clients.get(botId)?.bridge.revoke(userId),
          invite: async (botId, userId) => {
            const target = clients.get(botId);
            if (!target) throw new PublicError('The bot is disconnected.');
            return botInvitations.ensure(botId, userId, target.client, () => !stopping && access.has(userId, botId), signal);
          },
        });
        const settingsRequest = parseBotSettingsRequest(prompt);
        if (settingsRequest) return manageBotSettings(settingsRequest, { accounts, owner: access.owner, sender, config });
        const userCreation = parseUserCreation(prompt);
        if (userCreation) {
          if (creating) return 'Another account is being created. Retry when it finishes.';
          creating = true;
          try {
            return await createMatrixUser(config, userCreation, {
              sender, signal, interact, ready: () => tunnel?.waitUntilReady(signal) ?? Promise.resolve(),
            });
          } finally { creating = false; }
        }
        const accessRequest = parseAccessRequest(prompt);
        if (accessRequest?.action === 'users') return '### Shared access to all bots\n\n' + access.list().map(id => '- ' + inlineCode(id)).join('\n') + '\n\nPer-bot access list: `list access bot Bot Name`.';
        if (accessRequest) {
          if (sender !== access.owner) return 'Only the initial owner can change account access through this manager.';
          if (accounts.list().some(a => a.userId === accessRequest.userId)) return 'Bot accounts cannot be added as human users.';
          access.change(account.kind, sender, accessRequest.action, accessRequest.userId);
          if (accessRequest.action === 'remove') {
            for (const { bridge } of clients.values()) bridge.revoke(accessRequest.userId);
            return '**Access revoked:** ' + inlineCode(accessRequest.userId) + '\nA stop request was sent to this user’s active tasks.';
          }
          return '**Access granted:** ' + inlineCode(accessRequest.userId) + '\nThe user can chat with bots and create new ones. Start an encrypted DM; bot IDs are available through `list bots`.';
        }
        const request = parseManagerRequest(prompt);
        if (!request) return 'Command not recognized. Choose an example below and replace the name, path or Matrix ID with your own values.\n\n' + MANAGER_HELP;
        if (request.action === 'list') return managerBotList(accounts.list(), config.workspace);
        if (creating) return 'A bot is already being created. Try again shortly.';
        if (accounts.list().length >= 50) return 'The limit of 50 bot accounts has been reached.';
        creating = true;
        try {
          if (request.kind === 'grok' && !config.workerPort) throw new PublicError('Set WORKER_PORT on the host and restart before creating Grok bots.');
          if (request.kind === 'grok' && request.workspace) throw new PublicError('Grok runs on its external worker; configure its working directory there.');
          const workspace = request.kind === 'grok' ? undefined : await creationWorkspace(config, request.workspace, sender, interact, signal);
          if (workspace === null) return 'Bot creation cancelled. You can retry with a different folder.';
          signal.throwIfAborted();
          const requestedConfig = configForWorkspace(config, workspace);
          if (request.kind === 'claude') await checkClaude(requestedConfig, signal);
          await tunnel?.waitUntilReady(signal);
          const created = await provision(config, request.kind, request.name, signal);
          if (workspace !== undefined) created.workspace = workspace;
          created.inviteUserId = sender;
          accounts.add(created);
          try { await startAccount(created); } catch (error) {
            diagnostics(error);
            return '**Bot created, but startup failed:** ' + inlineCode(created.userId) + '\nCredentials saved. ' + markdownText(errorMessage(error, 'Bot startup failed')) + '\nCheck the server connection and restart the connector.';
          }
          return '**Bot created:** ' + markdownText(created.name) + '\n\n' + managerBotList([created], requestedConfig.workspace) + '\n\nAccept the encrypted DM invitation and send a task.';
        } finally { creating = false; }
      },
      receive: (event, key, signal) => media.receive(event.content!, key, signal),
      transcribe: (file, signal) => audio ? audio.transcribe(file, signal) : Promise.resolve(file),
      sendAttachments: (room, event, files, signal) => media.send(room, files, threadRelation(event), signal, async () => {
        if (!(await privateRoom(room, event.sender!))) throw new PublicError('Attachment withheld because this is no longer an encrypted DM with an allowed account.');
      }),
      async confirmation(room, event, text, controls, markdown) {
        await sendConfirmation(text, controls, {
          authorize: async () => {
            if (!(await privateRoom(room, event.sender!))) throw new PublicError('Confirmation withheld because this is no longer an encrypted DM with an allowed account.');
          },
          // Marked as a service message: it is neither a peer observation nor a turn trigger.
          sendMessage: content => client.sendMessage(room, { ...content, [SERVICE]: 'confirmation', 'm.relates_to': threadRelation(event) }),
          // Standard Matrix annotations are unencrypted, even in encrypted rooms.
          // Keep only the target event ID and emoji in the reaction payload.
          sendReaction: (eventId, key) => client.sendRawEvent(room, 'm.reaction', {
            'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
          }),
          report: diagnostics,
        }, markdown);
      },
      async reply(room, event, text, markdown = false, msgtype = 'm.notice', mentions) {
        const replyTo = threadRelation(event);
        const contents = replyContent(mentions?.length ? mentionText(text, mentions) : text, markdown, true, msgtype);
        const replyId = randomBytes(9).toString('base64url');
        for (const [index, content] of contents.entries()) {
          if (!(await privateRoom(room, event.sender!))) throw new PublicError('Reply withheld because this is no longer an encrypted DM with an allowed account.');
          // Only the last part mentions a peer, after the complete reply is delivered.
          await client.sendMessage(room, { ...links.outgoing(account.userId, room, content,
            index === contents.length - 1 ? mentions : undefined, replyId), 'm.relates_to': replyTo });
        }
      },
    });
    let incoming = Promise.resolve();
    const prepareIncoming = async (room: string, event: MatrixEvent) => {
      const shared = links.room(account.userId, room);
      if (shared) {
        if (!Number.isFinite(event.origin_server_ts) || event.origin_server_ts! < since || !(await privateRoom(room, shared.owner))) return;
        links.observe(account.userId, room, event);
        // Other agents are heard as context, never impersonated as the controller.
        // Only an explicit mention paid with peer credit starts a separate connector
        // notice turn; each agent evaluates it once, whichever bot recorded it first.
        if (event.sender !== shared.owner) {
          const mention = links.mention(account.userId, room, event);
          if (mention && bridge instanceof Bridge) void bridge.handleAgentMention(room, mention).catch(diagnostics);
          return;
        }
        if (!links.addressed(account.userId, room, event)) return;
      }
      // Serialize admission/observations, not model work: confirmations and
      // same-room steering must still get through while the agent is running.
      void bridge.handle(room, event).catch(diagnostics);
    };
    const inbox = (room: string, event: MatrixEvent) => { incoming = incoming.then(() => prepareIncoming(room, event)).catch(diagnostics); };
    if (account.kind !== 'grok') client.on('room.message', inbox);
    client.on('room.event', (room: string, event: MatrixEvent) => {
      if (account.kind !== 'grok' && event.type === 'm.reaction') inbox(room, event);
    });
    client.on('room.invite', (room: string, event: MatrixEvent) => {
      if (event.sender && authorized(event.sender)) void client.joinRoom(room).catch(diagnostics);
    });
    client.on('room.failed_decryption', () => console.warn(account.name + ': message could not be decrypted. Check device trust and key sharing in Element.'));
    let online = false;
    clients.set(account.userId, { client, bridge, privateRoom });
    if (background && bridge instanceof Bridge) {
      const codingBridge = bridge;
      backgroundPumps.set(account.userId, async () => {
        if (!online || starting || stopping || restart.pending || !clients.has(account.userId)) return;
        await codingBridge.drainQueued();
        await background.pump({
          valid: target => authorized(target.sender) && state.session(target.key)[account.kind as 'codex' | 'claude'] === target.session,
          deliver: (target, event, admitted, ready) => codingBridge.resumeBackground(target.room, event, target.session, admitted, ready),
          // A room timer is the bot's own message: no turn, mentions or human origin.
          post: async (target, text, admitted, ready) => {
            if (stopping || !(await privateRoom(target.room, target.sender))) return false;
            // Cancellation, reset, revocation or shutdown during the privacy check wins.
            if (stopping || restart.pending || !ready()) return false;
            admitted();
            const relation = target.thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: target.thread } } : {};
            for (const content of replyContent(text, true, true, 'm.text')) {
              await client.sendMessage(target.room, { ...content, 'm.mentions': {}, ...relation });
            }
            return true;
          },
          report: diagnostics,
        });
      });
    }
    try {
      if (!account.roomId) {
        const recipient = account.inviteUserId || config.owner;
        if (!authorized(recipient)) throw new PublicError('The account that requested this bot no longer has access.');
        const roomId = await client.createRoom({
          is_direct: true, visibility: 'private', preset: 'private_chat', invite: [recipient],
          initial_state: [
            { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
            { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
          ],
          power_level_content_override: { users: { [account.userId]: 100, [recipient]: 50 }, invite: 100 },
        });
        accounts.setRoom(account.userId, roomId);
      }
      phase('setup');
      await client.crypto.prepare();
      phase('cryptoPrepare');
      try {
        await ensureDeviceIdentity(client, account.userId, join(dir, 'device-recovery.json'));
        console.log(account.name + ': device cross-signing verified.');
      } catch (error) {
        console.warn(account.name + ': device verification incomplete; encrypted messaging remains available.');
        diagnostics(error);
      }
      phase('deviceIdentity');
      await client.start();
      // start() launches the sync loop without waiting for the first /sync response.
      phase('clientStart');
      online = true;
      console.log(account.name + ' (' + account.kind + ') online: ' + account.userId);
      console.log(JSON.stringify({ time: new Date().toISOString(), event: 'bot-startup', bot: account.userId,
        totalMs: Math.round(performance.now() - startedAt), phases }));
    } catch (error) { client.stop(); clients.delete(account.userId); workers.get(account.userId)?.stop(); workers.delete(account.userId); workerServer.remove(account.userId); throw error; }
  }
  for (const account of accounts.list()) {
    try { await startAccount(account); } catch (error) { console.error('Could not start ' + account.userId + '.'); diagnostics(error); }
  }
  starting = false;
  if (!clients.size) throw new PublicError('No bots could start. Check credentials, encryption support, and homeserver connectivity.');
  if (config.workerPort) await workerServer.start(config.workerPort);
  // Time since process start, including module loading.
  console.log(JSON.stringify({ time: new Date().toISOString(), event: 'connector-startup',
    bots: clients.size, elapsedMs: Math.round(performance.now()) }));
  notifySupervisor({ type: 'connector-ready' });
  const notifyRestart = async () => {
    if (stopping || restart.pending || notifyingRestart) return;
    notifyingRestart = true;
    try {
      const targets = accounts.list().sort((a, b) => Number(b.kind === 'manager') - Number(a.kind === 'manager'));
      await audioWarnings.deliver(targets.flatMap(account => {
        const started = clients.get(account.userId);
        const room = links.agent(account.userId)?.home ?? account.roomId;
        if (!started || !room) return [];
        const { client } = started;
        return [{
          allowed: async () => !stopping && !restart.pending &&
            await isPrivateRoom(client, room, account.userId, access.owner,
              sender => sender === access.owner && access.has(sender, account.kind === 'manager' ? undefined : account.userId)) &&
            !stopping && !restart.pending,
          send: (body: string) => client.sendMessage(room, { msgtype: 'm.notice', body, [SERVICE]: true, 'm.mentions': {} }),
        }];
      }));
      await restartNotice.deliver({
        isOwner: sender => sender === access.owner && access.has(sender),
        manager: () => {
          const manager = accounts.list().find(account => account.kind === 'manager' && account.roomId);
          return manager && { botId: manager.userId, roomId: manager.roomId!, sender: access.owner };
        },
        body: `Connector restarted. This bot is online and ready. Bots online: ${clients.size}/${accounts.list().length}.` +
          (clients.size < accounts.list().length ? ' Some bots failed to start; check the connector log.' : ''),
        client: botId => {
          const started = clients.get(botId);
          if (!started) return;
          const { client, privateRoom } = started;
          return {
            isPrivateRoom: privateRoom,
            encrypt: (room, content) => client.crypto.encryptRoomEvent(room, 'm.room.message', content),
            async send(room, transactionId, encrypted) {
              if (stopping) throw new PublicError('Restart notification deferred because the connector is stopping.');
              await client.doRequest('PUT', '/_matrix/client/v3/rooms/' + encodeURIComponent(room) +
                '/send/m.room.encrypted/' + encodeURIComponent(transactionId), null, encrypted);
            },
          };
        },
      });
      // Host-side handovers can write a notice after startup has finished.
      // Keep polling even when the inbox is empty; shutdown clears the timer.
    } catch (error) { diagnostics(error); }
    finally { notifyingRestart = false; }
  };
  restartNoticeTimer = setInterval(() => { void notifyRestart(); }, 30_000);
  restartNoticeTimer.unref();
  await notifyRestart();
}

main().catch(async error => { diagnostics(error); await tunnel?.stop(); process.exitCode = 1; });
