import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogLevel, LogService, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from '@vector-im/matrix-bot-sdk';
import { StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { MessageMatrixClient } from './message-matrix-client.js';
import { ExecutorQueue, type ExecutorTransport } from './executor-queue.js';
import { executorPolicy, executorRoomAllowed } from './executor-protocol.js';
import { lockInstance } from './instance-lock.js';
import { MatrixMedia } from './media.js';
import { safeErrorSummary } from './errors.js';

export function bindExecutorInbox(client: Pick<MessageMatrixClient, 'on' | 'inbox'>, queue: Pick<ExecutorQueue, 'receive'>, allowed: ExecutorTransport['allowed']) {
  // Only successfully decrypted text messages may submit commands.
  const decrypted = new Set<string>();
  client.on('room.decrypted_event', (_room, event) => {
    if (event.type === 'm.room.message' && event.event_id) decrypted.add(event.event_id);
  });
  client.inbox = async (room, event) => {
    if (!decrypted.delete(event.event_id)) return;
    await queue.receive(room, event, allowed);
  };
}

export async function executorMain() {
  process.umask(0o077);
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('The executor requires Linux or macOS.');
  if (process.getuid?.() === 0) throw new Error('Run the executor as an ordinary user; configure sudo separately.');
  const env = process.env;
  if (!env.EXECUTOR_POLICY || !env.EXECUTOR_DATA_DIR || !env.MATRIX_HOMESERVER || !env.MATRIX_ACCESS_TOKEN || !env.MATRIX_USER_ID) {
    throw new Error('Set EXECUTOR_POLICY, EXECUTOR_DATA_DIR, MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN and MATRIX_USER_ID.');
  }
  if (new URL(env.MATRIX_HOMESERVER).protocol !== 'https:') throw new Error('Use an HTTPS Matrix homeserver.');
  const policy = executorPolicy(JSON.parse(readFileSync(env.EXECUTOR_POLICY, 'utf8')));
  const bot = env.MATRIX_USER_ID;
  const dir = resolve(env.EXECUTOR_DATA_DIR);
  if (dir === policy.workspace) throw new Error('Use separate workspace and executor state directories.');
  if (process.argv.slice(2).some(a => a !== '--check-config')) throw new Error('Use no arguments or --check-config.');
  if (process.argv.includes('--check-config')) { console.log(`Executor configuration valid; mode ${policy.mode}. No network requests made.`); return; }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = lockInstance(realpathSync(dir));
  LogService.setLevel(LogLevel.ERROR);
  // Do not print SDK request objects, which can contain tokens or command content.
  LogService.setLogger({ info() {}, debug() {}, trace() {}, warn() {}, error() { console.error('Matrix transport error; retrying saved work.'); } });
  const client = new MessageMatrixClient(env.MATRIX_HOMESERVER, env.MATRIX_ACCESS_TOKEN,
    new SimpleFsStorageProvider(join(dir, 'matrix.json')), new RustSdkCryptoStorageProvider(join(dir, 'crypto'), StoreType.Sqlite));
  const queue = new ExecutorQueue(dir, bot, policy);
  client.history = { since: queue.since, heads: () => queue.heads, save: heads => queue.saveHeads(heads) };
  let stopped = false;
  const allowed = async (room: string, sender: string) => !stopped && policy.rooms.includes(room) && policy.senders.includes(sender) &&
    executorRoomAllowed(await client.getRoomState(room), bot, sender, policy);
  const media = new MatrixMedia(client, { workspace: policy.workspace, homeserver: env.MATRIX_HOMESERVER,
    accessToken: env.MATRIX_ACCESS_TOKEN, maxBytes: 8 * 1024 * 1024, scope: bot });
  const transport: ExecutorTransport = {
    allowed,
    prepare: async post => {
      const authorize = async () => { if (!await allowed(post.room, post.sender)) throw new Error('Executor room access changed.'); };
      const content = post.file ? await media.prepareAttachment({ path: post.file, root: dir, name: 'executor-output.log' }, AbortSignal.timeout(60000), authorize)
        : { msgtype: 'm.text', body: post.body };
      // Attachment captions retain the final status as well as the file name.
      if (post.file) content.body = post.body;
      return client.crypto.encryptRoomEvent(post.room, 'm.room.message', { ...content, 'm.mentions': post.wake ? { user_ids: [post.sender] } : {},
        ...(post.wake && { 'riftjack.executor_result': { ...post.wake, request: post.event } }),
        'm.relates_to': { rel_type: 'm.thread', event_id: post.event, is_falling_back: true, 'm.in_reply_to': { event_id: post.event } } });
    },
    send: async post => { await client.doRequest('PUT', '/_matrix/client/v3/rooms/' + encodeURIComponent(post.room) +
      '/send/m.room.encrypted/' + encodeURIComponent(post.id), null, post.encrypted); },
  };
  bindExecutorInbox(client, queue, allowed);
  client.on('room.invite', async (room, event) => {
    if (policy.rooms.includes(room) && policy.senders.includes(event.sender)) {
      try { await client.joinRoom(room); } catch { console.error('Could not join configured executor room.'); }
    }
  });
  client.on('worker.inbox_failure', () => { stopped = true; console.error('Executor inbox failed. Restart to recover the saved sync checkpoint.'); process.exit(1); });
  const me = await client.getWhoAmI();
  if (me.user_id !== bot || !me.device_id) throw new Error('Use a device-bound access token belonging to MATRIX_USER_ID.');
  await client.crypto.prepare();
  await client.start();
  const timer = setInterval(() => { if (!stopped) void queue.tick(transport).catch(e => console.error(safeErrorSummary(e))); }, 2000);
  const shutdown = () => { stopped = true; clearInterval(timer); client.stop(); release(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  console.log(`Executor started; mode ${policy.mode}. No model backend is configured.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void executorMain().catch(error => { console.error(safeErrorSummary(error)); process.exit(1); });
}
