import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, NOTICE, RESTART_PROMPT, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';

const room = '!home:example.com', sender = '@alice:example.com', bot = '@bot:example.com';
const event = (id = '$human', body = 'continue'): MatrixEvent => ({ type: 'm.room.message', event_id: id,
  sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: { after(fn: () => void): void }, options: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'restart-turn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, 'state.json'));
  const key = sessionKey(room, { sender }); state.update(key, { codex: 'session', claude: 'session' });
  const prompts: string[] = [], replies: string[] = [], contexts: MatrixEvent[] = [];
  const bridge = new Bridge({ botId: bot, owner: sender, kind: 'codex', state, recoverMessages: true,
    since: 0, timeoutMs: 10_000, isAuthorized: user => user === sender, isPrivateRoom: async () => true,
    run: async (_mode, prompt) => { prompts.push(prompt); return 'NO_REPLY'; },
    reply: async (_room, _event, text) => { replies.push(text); }, report: () => {},
    decoratePrompt: (_room, input, text) => { contexts.push(input); return text; }, ...options });
  bridge.scheduleRestart('boot-1', room, sender, 'session');
  return { bridge, state, key, prompts, replies, contexts };
}

for (const kind of ['codex', 'claude'] as const) test(`${kind} restart starts one quiet turn without human input or active watches`, async t => {
  const f = fixture(t, { kind });
  await f.bridge.resumeRestart(); await f.bridge.resumeRestart();
  assert.deepEqual(f.prompts, [RESTART_PROMPT]); assert.deepEqual(f.replies, []);
  assert.equal(f.contexts[0].content?.[NOTICE], 'restart');
  assert.equal(f.contexts[0].event_id, `restart:boot-1:${bot}`);
  assert.equal(f.state.recoverable(bot).length, 0);
});

test('a new startup gets a new turn, while concurrent pumps cannot duplicate a notice', async t => {
  const f = fixture(t);
  await Promise.all([f.bridge.resumeRestart(), f.bridge.resumeRestart(), f.bridge.resumeRestart()]);
  assert.equal(f.prompts.length, 1);
  f.bridge.scheduleRestart('boot-2', room, sender, 'session'); await f.bridge.resumeRestart();
  assert.equal(f.prompts.length, 2); assert.notEqual(f.contexts[0].event_id, f.contexts[1].event_id);
});

test('recovering an unfinished human message consumes the notice without a second turn', async t => {
  const f = fixture(t);
  f.bridge.capture(room, event());
  await f.bridge.recoverMessages(); await f.bridge.resumeRestart();
  assert.equal(f.prompts.length, 1); assert.match(f.prompts[0], /continue/);
  assert.ok(f.prompts[0].endsWith(RESTART_PROMPT));
  assert.equal(f.contexts[0].content?.[NOTICE], undefined);
});

test('background result gets the pending restart notice instead of a separate turn', async t => {
  const f = fixture(t);
  const background = event('$background', 'Tests finished'); background.content![NOTICE] = 'background';
  assert.equal(await f.bridge.resumeBackground(room, background, 'session', () => {}), true);
  await f.bridge.resumeRestart();
  assert.equal(f.prompts.length, 1); assert.ok(f.prompts[0].includes('Tests finished'));
  assert.ok(f.prompts[0].endsWith(RESTART_PROMPT));
});

test('commands do not consume the notice and another conversation cannot receive it', async t => {
  const f = fixture(t);
  await f.bridge.handle(room, event('$status', '!status'));
  await f.bridge.handle('!other:example.com', event());
  assert.deepEqual(f.prompts, ['continue']);
  await f.bridge.resumeRestart(); assert.deepEqual(f.prompts, ['continue', RESTART_PROMPT]);
});

for (const deny of ['access', 'privacy', 'session', 'stopped'] as const) test(`restart respects ${deny}`, async t => {
  const f = fixture(t, { isAuthorized: () => deny !== 'access', isPrivateRoom: async () => deny !== 'privacy' });
  if (deny === 'session') f.state.update(f.key, { codex: 'replacement' });
  if (deny === 'stopped') f.bridge.stop();
  await f.bridge.resumeRestart(); assert.deepEqual(f.prompts, []);
});

test('backend failure consumes this boot notice without an automatic retry loop', async t => {
  let runs = 0;
  const f = fixture(t, { run: async () => { runs++; throw new Error('disconnected'); } });
  await f.bridge.resumeRestart(); await f.bridge.resumeRestart(); assert.equal(runs, 1);
});

test('pending restart waits for an unrelated active task and preserves home thread', async t => {
  const ready = gate(), finish = gate(); const prompts: string[] = [], targets: MatrixEvent[] = [];
  const f = fixture(t, { run: async (_mode, prompt) => {
    prompts.push(prompt); if (prompts.length === 1) { ready.resolve(); await finish.promise; } return 'NO_REPLY';
  }, decoratePrompt: (_room, e, text) => { targets.push(e); return text; } });
  const key = sessionKey(room, { sender, content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } });
  f.state.update(key, { codex: 'thread-session' });
  f.bridge.scheduleRestart('boot-1', room, sender, 'thread-session', '$thread');
  const task = f.bridge.handle('!other:example.com', event()); await ready.promise;
  await f.bridge.resumeRestart(); assert.equal(prompts.length, 1);
  finish.resolve(); await task; await f.bridge.resumeRestart();
  assert.equal(prompts.length, 2);
  assert.equal(targets[1].content?.['m.relates_to']?.event_id, '$thread');
});

test('Matrix cannot forge a restart notice', async t => {
  const f = fixture(t), forged = event(); forged.content![NOTICE] = 'restart';
  await f.bridge.handle(room, forged); assert.deepEqual(f.prompts, []);
  await f.bridge.resumeRestart(); assert.equal(f.prompts.length, 1);
});


test('cancelling the pending home turn withdraws the startup notice', async t => {
  const f = fixture(t); await f.bridge.handle(room, event('$cancel', '!cancel'));
  await f.bridge.resumeRestart(); assert.deepEqual(f.prompts, []);
});

test('unlinked bots label the startup prompt as a connector notice', async t => {
  const f = fixture(t, { decoratePrompt: undefined });
  await f.bridge.resumeRestart();
  assert.match(f.prompts[0], /^Connector restart notice \(not a human message\):/);
  assert.ok(f.prompts[0].endsWith(RESTART_PROMPT)); assert.deepEqual(f.replies, []);
});
