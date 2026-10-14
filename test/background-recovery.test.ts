import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { Bridge, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';

const event: MatrixEvent = { type: 'm.room.message', sender: '@alice:test', content: { msgtype: 'm.text', body: 'Check' } };
const target: BackgroundTarget = { room: '!room:test', sender: '@alice:test', key: sessionKey('!room:test', event), session: 'session-1' };
function setup(t: { after(fn: () => void): void }, kind: 'codex' | 'claude' = 'codex') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-recovery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'tasks.json'), state = new State(join(root, 'state.json'));
  state.update(target.key, { [kind]: target.session });
  const queue = new BackgroundTasks(file, root), prompts: string[] = [], replies: string[] = [];
  let fail = true;
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 10_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {},
    reply: async (_r, _e, text) => { replies.push(text); },
    run: async (_m, prompt) => { prompts.push(prompt); if (fail) throw new Error('Backend stopped'); return 'NO_REPLY'; },
  });
  const options = { valid: () => true, report: () => {},
    deliver: (to: BackgroundTarget, message: MatrixEvent, admit: () => void, ready: () => boolean, completed: (cancelled?: boolean) => void) =>
      bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) };
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).watches[0];
  return { root, file, state, queue, bridge, prompts, replies, options, saved, succeed: () => { fail = false; } };
}

for (const kind of ['codex', 'claude'] as const) test(`${kind}: failed timer remains recoverable after an admitted backend failure`, async t => {
  const f = setup(t, kind);
  const registered = JSON.parse(f.queue.action({ action: 'remind', label: 'Check', message: 'Inspect existing results.', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal));
  const due = Date.parse(registered.due);
  await f.queue.pump(f.options, due);
  assert.equal(f.saved().state, 'interrupted');
  await f.queue.pump(f.options, due);
  assert.equal(f.prompts.length, 1, 'no immediate failure loop');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options, due);
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1]!, /previous.*turn.*not finish/i);
  assert.equal(f.saved().state, 'delivered');
  assert.ok(!f.replies.includes('NO_REPLY'), 'a deliberate silent completion is successful');
  await new BackgroundTasks(f.file, f.root).pump(f.options, due);
  assert.equal(f.prompts.length, 2, 'no repeat after success');
});

test('a watch recovers the observed result even if its status file changes', async t => {
  const f = setup(t);
  writeFileSync(join(f.root, 'status.json'), '{"status":"complete"}');
  f.queue.action({ action: 'watch', label: 'Build', status_file: 'status.json', field: 'status', terminal: ['complete'] }, target, new AbortController().signal);
  await f.queue.pump(f.options);
  assert.equal(f.saved().state, 'interrupted');
  writeFileSync(join(f.root, 'status.json'), '{"status":"running"}');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options);
  assert.match(f.prompts[1]!, /"status":"complete"/);
  assert.equal(f.saved().state, 'delivered');
});

test('a recurring timer recovers the same occurrence before its next scheduled run', async t => {
  const f = setup(t);
  const registered = JSON.parse(f.queue.action({ action: 'remind', label: 'Daily', message: 'Check', deliver: 'agent',
    schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } }, target, new AbortController().signal));
  const due = Date.parse(registered.due);
  await f.queue.pump(f.options, due);
  const interrupted = f.saved(), id = interrupted.delivery.id, next = interrupted.expires;
  assert.equal(interrupted.timer.lastRun.due, due);
  assert.ok(next > due);
  f.succeed();
  const received: string[] = [];
  const queue = new BackgroundTasks(f.file, f.root);
  await queue.pump({ ...f.options, deliver: async (to, message, admit, ready, completed) => {
    received.push(message.event_id!); return f.options.deliver(to, message, admit, ready, completed);
  } }, due);
  assert.equal(received[0], id);
  assert.equal(f.saved().expires, next);
  assert.equal(f.saved().timer.lastRun.state, 'delivered');
  await queue.pump(f.options, due);
  assert.equal(f.prompts.length, 2);
  await queue.pump(f.options, next);
  assert.equal(f.prompts.length, 3);
  assert.doesNotMatch(f.prompts[2]!, /Connector recovery/);
});

for (const reason of ['cancel', 'revoke', 'session'] as const) test(`recovery respects ${reason}`, async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  await f.queue.pump(f.options, f.saved().expires);
  if (reason === 'cancel') f.queue.action({ action: 'cancel', id: f.saved().id }, target, new AbortController().signal);
  if (reason === 'session') f.state.reset(target.key);
  const queue = new BackgroundTasks(f.file, f.root);
  await queue.pump({ ...f.options, valid: () => reason !== 'revoke' && f.state.session(target.key).codex === target.session }, Date.now() + 120_000);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.saved().state, 'cancelled');
});

test('delivery failure after backend success remains recoverable', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state: f.state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {},
    run: async () => 'The result', reply: async () => { throw new Error('Matrix unavailable'); } });
  await f.queue.pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) }, f.saved().expires);
  assert.equal(f.saved().state, 'interrupted');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.saved().state, 'delivered');
});

test('cancel of an active notification is terminal, not a recoverable backend error', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state: f.state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {}, reply: async () => {},
    run: async (_m, _p, _k, signal) => { entered(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return ''; } });
  const pumping = f.queue.pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) }, f.saved().expires);
  await started;
  await bridge.handle(target.room, { ...event, event_id: '$cancel', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: '!cancel' } });
  await pumping;
  assert.equal(f.saved().state, 'cancelled');
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.prompts.length, 0);
});

test('a real process exit after admission preserves the notification for restart', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { BackgroundTasks } from './src/background-tasks.ts';
    import { Bridge } from './src/bridge.ts';
    import { State } from './src/state.ts';
    const root = process.argv[1];
    const queue = new BackgroundTasks(root + '/tasks.json', root);
    const bridge = new Bridge({botId:'@bot:test',kind:'codex',since:0,timeoutMs:10000,state:new State(root+'/state.json'),
      isAuthorized:()=>true,isPrivateRoom:async()=>true,report:()=>{},reply:async()=>{},run:async()=>{process.exit(23);}});
    await queue.pump({valid:()=>true,report:()=>{},deliver:(to,event,admit,ready,completed)=>bridge.resumeBackground(to.room,event,to.session,admit,ready,completed)},Date.now()+120000);
  `, f.root], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(f.saved().state, 'dispatching');
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.saved().state, 'delivered');
  assert.match(f.prompts[0]!, /Connector recovery after restart/);
});

test('a failed human follow-up does not replay an already completed notification', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  let entered!: () => void, release!: () => void, turns = 0;
  const started = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state: f.state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {}, reply: async () => {}, steer: async () => false,
    run: async () => {
      if (++turns === 1) { entered(); await wait; return 'Finished'; }
      assert.equal(f.saved().state, 'delivered', 'checkpoint before starting the follow-up');
      throw new Error('Follow-up failed');
    } });
  const pumping = f.queue.pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) }, f.saved().expires);
  await started;
  await bridge.handle(target.room, { ...event, event_id: '$followup', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: 'Another task' } });
  release(); await pumping;
  assert.equal(turns, 2);
  assert.equal(f.saved().state, 'delivered');
  await new BackgroundTasks(f.file, f.root).pump(f.options, Date.now() + 120_000);
  assert.equal(f.prompts.length, 0);
});

test('pending recovery cannot be pruned by completed tasks or duplicated by registration', async t => {
  const f = setup(t);
  writeFileSync(join(f.root, 'status.json'), '{"status":"complete"}');
  const input = { action: 'watch', label: 'Build', status_file: 'status.json', field: 'status', terminal: ['complete'] };
  const original = JSON.parse(f.queue.action(input, target, new AbortController().signal));
  await f.queue.pump(f.options);
  assert.equal(JSON.parse(f.queue.action(input, target, new AbortController().signal)).id, original.id);
  for (let i = 0; i < 110; i++) {
    const timer = JSON.parse(f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'room', delay_minutes: 1 }, target, new AbortController().signal));
    f.queue.action({ action: 'cancel', id: timer.id }, target, new AbortController().signal);
  }
  f.succeed();
  await new BackgroundTasks(f.file, f.root).pump(f.options);
  assert.equal(f.prompts.length, 2);
});


test('recovered notifications survive a new bridge with a later startup time', async t => {
  const f = setup(t);
  f.queue.action({ action: 'remind', label: 'Check', message: 'Check', deliver: 'agent', delay_minutes: 1 }, target, new AbortController().signal);
  await f.queue.pump(f.options, f.saved().expires);
  let calls = 0;
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: f.saved().delivery.time + 1, timeoutMs: 10_000, state: f.state,
    isAuthorized: () => true, isPrivateRoom: async () => true, report: () => {}, reply: async () => {},
    run: async () => { calls++; return 'NO_REPLY'; } });
  await new BackgroundTasks(f.file, f.root).pump({ ...f.options, deliver: (to, message, admit, ready, completed) =>
    bridge.resumeBackground(to.room, message, to.session, admit, ready, completed) });
  assert.equal(calls, 1);
  assert.equal(f.saved().state, 'delivered');
});
