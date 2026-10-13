import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';
import { MessageMatrixClient, fillTimeline } from '../src/message-matrix-client.js';

const bot = '@bot:example.com', owner = '@alice:example.com', room = '!dm:example.com';
const event = (id: string, body = id): MatrixEvent => ({ type: 'm.room.message', event_id: id, sender: owner,
  origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'message-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const create = (options: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) => {
    const state = new State(file), prompts: string[] = [], replies: string[] = [];
    const bridge = new Bridge({ botId: bot, owner, kind: 'codex', state, recoverMessages: true,
      since: state.messageSince(bot, 1000), timeoutMs: 10_000, isAuthorized: sender => sender === owner,
      isPrivateRoom: async () => true, report: () => {},
      run: async (_mode, prompt) => { prompts.push(prompt); return 'done'; },
      reply: async (_room, _event, text) => { replies.push(text); }, ...options });
    return { bridge, state, prompts, replies };
  };
  return { create, file };
}

test('failed turn survives a fresh State and Bridge, replays once with original context and warning', async t => {
  const { create } = fixture(t);
  const first = create({ run: async () => { throw new Error('backend disconnected'); } });
  const original = event('$1', 'Continue the change');
  original.content!['m.relates_to'] = { rel_type: 'm.thread', event_id: '$thread' };
  await first.bridge.handle(room, original);
  assert.equal(first.state.recoverable(bot).length, 1);
  assert.equal(first.state.recoverable(bot)[0].attempted, true);
  await first.bridge.drainQueued();
  const second = create();
  await second.bridge.recoverMessages();
  assert.match(second.prompts[0], /previous turn.*did not finish/);
  assert.match(second.prompts[0], /Continue the change/);
  assert.equal(second.state.recoverable(bot).length, 0);
  await second.bridge.handle(room, original);
  const third = create(); await third.bridge.recoverMessages();
  assert.equal(second.prompts.length, 1); assert.equal(third.prompts.length, 0);
});

test('captured but not admitted messages recover in order without partial-work warning', async t => {
  const { create } = fixture(t), first = create();
  first.bridge.capture(room, event('$1')); first.bridge.capture(room, event('$2'));
  first.bridge.capture(room, event('$1'));
  const second = create(); await second.bridge.recoverMessages();
  assert.deepEqual(second.prompts, ['$1', '$2']);
});

test('shutdown recovers active input and accepted steering; explicit cancellation does not', async t => {
  for (const cancel of [false, true]) {
    const { create } = fixture(t), ready = gate();
    const first = create({ steer: async () => true, run: async (_mode, _prompt, _key, signal) => {
      ready.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted(); return '';
    } });
    const run = first.bridge.handle(room, event('$1')); await ready.promise;
    await first.bridge.handle(room, event('$2'));
    if (cancel) await first.bridge.handle(room, event('$cancel', '!cancel')); else first.bridge.stop();
    await run;
    const second = create(); await second.bridge.recoverMessages();
    assert.equal(second.prompts.length, cancel ? 0 : 2);
  }
});

test('queued other-room input survives dequeue followed by backend failure', async t => {
  const { create } = fixture(t), ready = gate(), finish = gate(); let runs = 0;
  const first = create({ run: async () => { if (++runs === 1) { ready.resolve(); await finish.promise; return 'done'; } throw new Error('failed'); } });
  const task = first.bridge.handle(room, event('$1')); await ready.promise;
  await first.bridge.handle('!other:example.com', event('$2')); finish.resolve(); await task;
  while (first.bridge.busy) await new Promise(resolve => setImmediate(resolve));
  const second = create(); await second.bridge.recoverMessages();
  assert.equal(second.prompts.length, 1); assert.match(second.prompts[0], /\$2/);
});

test('success, NO_REPLY, and cancellation of failed input are terminal', async t => {
  const { create } = fixture(t);
  const first = create({ shared: () => true, run: async () => 'NO_REPLY' });
  await first.bridge.handle(room, event('$quiet'));
  const failed = create({ run: async () => { throw new Error('failed'); } });
  await failed.bridge.handle(room, event('$failure'));
  await failed.bridge.handle(room, event('$cancel', '!cancel'));
  const second = create(); await second.bridge.recoverMessages(); assert.deepEqual(second.prompts, []);
});

test('recovery rechecks authorization, room privacy and routing; commands are never journaled', async t => {
  for (const denial of ['access', 'privacy', 'route']) {
    const { create } = fixture(t), first = create(); first.bridge.capture(room, event('$1'));
    first.bridge.capture(room, event('$command', '!restart'));
    first.bridge.capture(room, event('$quoted', '> quoted\n\n!approve 123'));
    assert.equal(first.state.recoverable(bot).length, 1);
    const second = create({ isAuthorized: () => denial !== 'access', isPrivateRoom: async () => denial !== 'privacy' });
    await second.bridge.recoverMessages(async () => denial !== 'route');
    assert.equal(second.prompts.length, 0); assert.equal(second.state.recoverable(bot).length, 0);
  }
});

test('failed final delivery retains input; failed steering remains recoverable even if original succeeds', async t => {
  const { create } = fixture(t);
  const first = create({ reply: async () => { throw new Error('network'); } });
  await assert.rejects(first.bridge.handle(room, event('$delivery')));
  assert.equal(first.state.recoverable(bot).length, 1);
  const ready = gate(), finish = gate();
  const running = create({ steer: async () => { throw new Error('uncertain'); },
    run: async () => { ready.resolve(); await finish.promise; return 'done'; } });
  const task = running.bridge.handle(room, event('$original')); await ready.promise;
  await running.bridge.handle(room, event('$update')); finish.resolve(); await task;
  const second = create(); await second.bridge.recoverMessages();
  assert.equal(second.prompts.length, 2);
  assert.match(second.prompts[1], /\$update/);
});

test('saved startup boundary accepts offline input but ignores pre-install history', async t => {
  const { create, file } = fixture(t); create();
  const state = new State(file); assert.equal(state.messageSince(bot, 5000), 1000);
  const next = create();
  await next.bridge.handle(room, { ...event('$old'), origin_server_ts: 500 });
  await next.bridge.handle(room, event('$offline'));
  assert.deepEqual(next.prompts, ['$offline']);
});

test('limited timeline is backfilled in order to saved room head, without duplicates', async () => {
  const pages: string[] = [];
  const result = await fillTimeline({ events: [event('$5')], prev_batch: 'a' }, '$1', 0, async from => {
    pages.push(from); return from === 'a' ? { chunk: [event('$4'), event('$3')], end: 'b' }
      : { chunk: [event('$3'), event('$2'), event('$1'), event('$old')], end: 'c' };
  });
  assert.deepEqual(result.map(e => e.event_id), ['$2', '$3', '$4', '$5']);
  assert.deepEqual(pages, ['a', 'b']);
});

test('history pagination failure stops before checkpoint; recovery events use SDK processing', async () => {
  class Client extends MessageMatrixClient { process(raw: any) { return this.processSync(raw, async (type, ...args) => {
    if (type === 'room.message') await this.inbox?.(args[0], args[1]);
  }); } }
  const client = new Client('https://matrix.example.com', 'test');
  const heads: Record<string, string> = { [room]: '$1' }, delivered: string[] = [];
  client.history = { since: 0, heads: () => ({ ...heads }), save: value => Object.assign(heads, value) };
  client.inbox = async (_room, e) => { delivered.push(e.event_id); };
  let failed = false;
  client.on('worker.inbox_failure', () => { failed = true; });
  client.doRequest = async () => { throw new Error('offline'); };
  const raw = () => ({ rooms: { join: { [room]: { timeline: { limited: true, prev_batch: 'a', events: [event('$3')] } } } } });
  await assert.rejects(client.process(raw())); assert.equal(failed, true); assert.equal(heads[room], '$1');
  client.doRequest = (async () => ({ chunk: [event('$2'), event('$1')] })) as typeof client.doRequest;
  await client.process(raw());
  assert.deepEqual(delivered, ['$2', '$3']); assert.equal(heads[room], '$3');
});

test('a Matrix redelivery during recovery cannot steer the same input twice', async t => {
  const { create } = fixture(t), first = create(); first.bridge.capture(room, event('$1'));
  const ready = gate(), finish = gate(); let steers = 0, runs = 0;
  const second = create({ steer: async () => { steers++; return true; }, run: async () => {
    runs++; ready.resolve(); await finish.promise; return 'done';
  } });
  const recovering = second.bridge.recoverMessages(); await ready.promise;
  await second.bridge.handle(room, event('$1'));
  finish.resolve(); await recovering;
  assert.equal(runs, 1); assert.equal(steers, 0);
  assert.equal(second.state.recoverable(bot).length, 0);
});

test('new input waits behind restart recovery without overlapping model calls', async t => {
  const { create } = fixture(t), first = create(); first.bridge.capture(room, event('$1'));
  const ready = gate(), finish = gate(); const order: string[] = [];
  const second = create({ run: async (_mode, prompt) => {
    order.push(prompt); if (order.length === 1) { ready.resolve(); await finish.promise; } return 'done';
  } });
  const recovering = second.bridge.recoverMessages(); await ready.promise;
  await second.bridge.handle('!other:example.com', event('$2'));
  assert.deepEqual(order, ['$1']); finish.resolve(); await recovering;
  while (second.bridge.busy) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['$1', '$2']);
});

test('real SDK sync saves message before checkpoint, and disk failure keeps the previous token', async t => {
  const { SimpleFsStorageProvider } = await import('@vector-im/matrix-bot-sdk');
  for (const fail of [false, true]) {
    const { create, file } = fixture(t), f = create();
    const storage = new SimpleFsStorageProvider(file + '.matrix'); storage.setSyncToken('previous');
    class Client extends MessageMatrixClient {
      run() { return this.startSyncInternal(); }
      protected override async doSync() { return { next_batch: 'next', rooms: { join: {
        [room]: { timeline: { events: [event('$sync')] } },
      } } }; }
    }
    const client = new Client('https://matrix.example.com', 'test', storage);
    let fatal = false; client.on('worker.inbox_failure', () => { fatal = true; });
    client.inbox = async (target, input) => {
      assert.equal(storage.getSyncToken(), 'previous');
      if (fail) throw new Error('disk unavailable');
      f.bridge.capture(target, input); client.stop();
    };
    await client.run(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(fatal, fail); assert.equal(storage.getSyncToken(), fail ? 'previous' : 'next');
    const restarted = create(); await restarted.bridge.recoverMessages();
    assert.deepEqual(restarted.prompts, fail ? [] : ['$sync']);
  }
});

test('abrupt process exit during model work leaves a recoverable original message', async t => {
  const { spawnSync } = await import('node:child_process');
  const { create, file } = fixture(t);
  const source = `
    import { State } from ${JSON.stringify(new URL('../src/state.ts', import.meta.url).href)};
    import { Bridge } from ${JSON.stringify(new URL('../src/bridge.ts', import.meta.url).href)};
    const state = new State(${JSON.stringify(file)});
    const bridge = new Bridge({ botId: ${JSON.stringify(bot)}, kind: 'codex', state, recoverMessages: true,
      since: state.messageSince(${JSON.stringify(bot)}, 1000), timeoutMs: 10000,
      isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {}, reply: async () => {},
      run: async () => { process.exit(23); } });
    await bridge.handle(${JSON.stringify(room)}, ${JSON.stringify(event('$crash'))});`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const restarted = create(); await restarted.bridge.recoverMessages();
  assert.equal(restarted.prompts.length, 1); assert.match(restarted.prompts[0], /\$crash/);
  assert.match(restarted.prompts[0], /Inspect the existing results/);
});
