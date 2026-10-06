import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';
import { Bridge, sessionKey, type MatrixEvent, type BackendHooks } from '../src/bridge.js';
import { State } from '../src/state.js';

const signal = () => new AbortController().signal;
const event: MatrixEvent = { type: 'm.room.message', event_id: '$start', sender: '@alice:test', origin_server_ts: 1,
  content: { msgtype: 'm.text', body: 'Continue the task.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
const target: BackgroundTarget = { room: '!room:test', sender: '@alice:test', thread: '$thread', key: sessionKey('!room:test', event), session: 'session-1' };
const input = { action: 'watch', label: 'Example build', status_file: 'status.json', field: 'stage', terminal: ['complete', 'failed'] };
function setup(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-background-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const status = (stage: string) => writeFileSync(join(root, 'status.json'), JSON.stringify({ stage, ignored: 'do not forward private data' }));
  status('building');
  const file = join(root, 'watches.json');
  return { root, file, status, queue: new BackgroundTasks(file, root) };
}
const report = (error: unknown) => { throw error; };

test('recurring reminders survive downtime and restart without replaying or catching up missed runs', async t => {
  const f = setup(t);
  const input = { action: 'remind', label: 'Daily', message: 'Check project updates.', deliver: 'agent',
    schedule: { frequency: 'daily', time: '09:00', timezone: 'Europe/London' } };
  const registered = JSON.parse(f.queue.action(input, target, signal()));
  const now = Date.parse(registered.due) + 4 * 86_400_000;
  const ids: string[] = [];
  const options = { valid: () => true, report, deliver: async (_t: BackgroundTarget, e: MatrixEvent, admit: () => void) => {
    admit(); ids.push(e.event_id!); return true;
  } };
  await f.queue.pump(options, now);
  let queue = new BackgroundTasks(f.file, f.root);
  await queue.pump(options, now);
  const saved = JSON.parse(queue.action({ action: 'list' }, target, signal()))[0];
  assert.equal(ids.length, 1); assert.equal(saved.id, registered.id);
  assert.equal(saved.state, 'waiting'); assert.equal(saved.lastRun.state, 'delivered');
  assert.ok(Date.parse(saved.due) > now);
  await queue.pump(options, Date.parse(saved.due));
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  queue.action({ action: 'cancel', id: registered.id }, target, signal());
  queue = new BackgroundTasks(f.file, f.root);
  await queue.pump(options, now + 10 * 86_400_000);
  assert.equal(ids.length, 2);
});

test('recurring reminders advance before admission and retain future runs after uncertain delivery', async t => {
  const f = setup(t);
  const registered = JSON.parse(f.queue.action({ action: 'remind', label: 'Weekly', message: 'Check', deliver: 'room',
    schedule: { frequency: 'weekly', weekday: 1, time: '09:00', timezone: 'UTC' } }, target, signal()));
  const due = Date.parse(registered.due);
  await f.queue.pump({ valid: () => true, report, deliver: async () => false, post: async () => false }, due);
  assert.equal(JSON.parse(f.queue.action({ action: 'list' }, target, signal()))[0].due, registered.due);
  let recovered: BackgroundTasks | undefined;
  await f.queue.pump({ valid: () => true, report: () => {}, deliver: async () => false,
    post: async (_t, _text, admit) => { admit(); recovered = new BackgroundTasks(f.file, f.root); throw new Error('Uncertain send'); } }, due);
  const saved = JSON.parse(recovered!.action({ action: 'list' }, target, signal()))[0];
  assert.equal(saved.lastRun.state, 'interrupted'); assert.equal(saved.state, 'waiting');
  assert.match(recovered!.summary(target.key, target.session), /1 interrupted/);
  assert.ok(Date.parse(saved.due) > due);
  await recovered!.pump({ valid: () => true, report, deliver: async () => assert.fail('No replay'), post: async () => assert.fail('No replay') }, due);
  await recovered!.pump({ valid: () => false, report, deliver: async () => assert.fail('Revoked schedule') }, Date.parse(saved.due));
  assert.equal(JSON.parse(recovered!.action({ action: 'list' }, target, signal()))[0].state, 'cancelled');
});

test('recurring reminders reject mixed timing forms and invalid persisted schedules', t => {
  const f = setup(t);
  const input = { action: 'remind', label: 'Daily', message: 'Check', deliver: 'agent',
    schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } };
  for (const extra of [{ delay_minutes: 1 }, { at: new Date(Date.now() + 60_000).toISOString() },
    { schedule: { ...input.schedule, timezone: 'Invalid/Zone' } }, { schedule: { ...input.schedule, weekday: 2 } }]) {
    assert.throws(() => f.queue.action({ ...input, ...extra }, target, signal()), /Use remind/);
  }
  f.queue.action(input, target, signal());
  const data = JSON.parse(readFileSync(f.file, 'utf8'));
  data.watches[0].timer.schedule.timezone = 'Invalid/Zone';
  writeFileSync(f.file, JSON.stringify(data));
  assert.throws(() => new BackgroundTasks(f.file, f.root), /Invalid background/);
});

test('cancelling a recurring reminder during delivery stops future runs', async t => {
  const f = setup(t);
  const registered = JSON.parse(f.queue.action({ action: 'remind', label: 'Daily', message: 'Check', deliver: 'agent',
    schedule: { frequency: 'daily', time: '09:00', timezone: 'UTC' } }, target, signal()));
  let calls = 0;
  const options = { valid: () => true, report, deliver: async (_t: BackgroundTarget, _e: MatrixEvent, admit: () => void) => {
    admit(); calls++;
    assert.equal(JSON.parse(f.queue.action({ action: 'cancel', id: registered.id }, target, signal())).state, 'cancelled');
    return true;
  } };
  await f.queue.pump(options, Date.parse(registered.due));
  await f.queue.pump(options, Date.parse(registered.due) + 3 * 86_400_000);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(f.queue.action({ action: 'list' }, target, signal()))[0].state, 'cancelled');
});

test('watches survive restart and dispatch a terminal result only once to the bound thread', async t => {
  const f = setup(t);
  const first = JSON.parse(f.queue.action(input, target, signal()));
  assert.equal(JSON.parse(f.queue.action(input, target, signal())).id, first.id);
  assert.throws(() => f.queue.action({ ...input, terminal: ['different'] }, target, signal()), /different terminal states/);
  const queue = new BackgroundTasks(f.file, f.root);
  let count = 0;
  const options = { valid: () => true, report,
    deliver: async (destination: BackgroundTarget, message: MatrixEvent, admit: () => void) => {
      admit(); count++;
      assert.equal(destination.session, target.session);
      assert.equal(sessionKey(destination.room, message), target.key);
      assert.match(message.content!.body!, /"status":"failed"/);
      assert.doesNotMatch(message.content!.body!, /private data/);
      return true;
    } };
  await queue.pump(options); assert.equal(count, 0);
  f.status('failed'); await queue.pump(options); await queue.pump(options);
  await new BackgroundTasks(f.file, f.root).pump(options);
  assert.equal(count, 1);
});

test('busy delivery remains pending, while reset or revoked access cancels it', async t => {
  const f = setup(t); f.queue.action(input, target, signal()); f.status('complete');
  await f.queue.pump({ valid: () => true, report, deliver: async () => false });
  assert.match(f.queue.summary(target.key, target.session), /1 waiting/);
  await f.queue.pump({ valid: () => false, report, deliver: async () => assert.fail('Revoked watch must not deliver') });
  assert.equal(JSON.parse(f.queue.action({ action: 'list' }, target, signal()))[0].state, 'cancelled');
});

test('missing or malformed files expire and a crash during delivery is never replayed', async t => {
  const f = setup(t); f.queue.action(input, target, signal());
  writeFileSync(join(f.root, 'status.json'), '{partial');
  await f.queue.pump({ valid: () => true, report, deliver: async () => assert.fail('Partial write is not completion') });
  let recovered: BackgroundTasks | undefined;
  await f.queue.pump({ valid: () => true, report, deliver: async (_t, message, admit) => {
    assert.match(message.content!.body!, /"status":"watch_expired"/);
    admit(); recovered = new BackgroundTasks(f.file, f.root);
    return true;
  } }, Date.now() + 25 * 3_600_000);
  assert.match(recovered!.summary(target.key, target.session), /1 interrupted/);
  await recovered!.pump({ valid: () => true, report, deliver: async () => assert.fail('Uncertain turn must not replay') });
});

test('watch input is scoped, bounded, cancellable, and cannot read outside the workspace', async t => {
  const f = setup(t);
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'outside-watch-')));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  writeFileSync(join(other, 'outside.json'), '{"stage":"complete"}');
  symlinkSync(join(other, 'outside.json'), join(f.root, 'link.json'));
  for (const value of [{ ...input, status_file: join(other, 'outside.json') }, { ...input, status_file: 'link.json' },
    { ...input, room: '!other:test' }, { ...input, terminal: [] }, { ...input, timeout_hours: 0 }]) {
    assert.throws(() => f.queue.action(value, target, signal()));
  }
  const { id } = JSON.parse(f.queue.action(input, target, signal()));
  const otherTarget = { ...target, key: 'another-conversation' };
  assert.equal(f.queue.action({ action: 'list' }, otherTarget, signal()), '[]');
  assert.throws(() => f.queue.action({ action: 'cancel', id }, otherTarget, signal()));
  f.queue.action({ action: 'cancel', id }, target, signal());
  f.status('complete'); await f.queue.pump({ valid: () => true, report, deliver: async () => assert.fail('Cancelled') });
  const controller = new AbortController(); controller.abort();
  assert.throws(() => f.queue.action(input, target, controller.signal));
});

test('a substituted status symlink is revalidated on every poll', async t => {
  const f = setup(t); f.queue.action(input, target, signal());
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-watch-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'status.json'), '{"stage":"complete"}');
  rmSync(join(f.root, 'status.json')); symlinkSync(join(outside, 'status.json'), join(f.root, 'status.json'));
  await f.queue.pump({ valid: () => true, report, deliver: async () => assert.fail('Outside file') });
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} resumes only an idle unchanged session, and callbacks expire with the turn`, async t => {
  const f = setup(t), state = new State(join(f.root, 'sessions.json'));
  state.update(target.key, { [kind]: target.session });
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(r => entered = r);
  const wait = new Promise<void>(r => release = r);
  let hooks: BackendHooks | undefined, registered = 0, admitted = 0, turns = 0;
  const replies: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 10_000, state,
    isAuthorized: sender => sender === target.sender, isPrivateRoom: async () => true,
    reply: async (_r, _e, text) => { replies.push(text); }, report,
    background: async (_input, context) => { assert.equal(context.key, target.key); registered++; return 'registered'; },
    run: async (_m, _p, key, _s, _u, _a, _i, _pub, callbacks) => {
      turns++; hooks = callbacks; assert.equal(key, target.key); entered(); await wait; return 'Finished.';
    },
  });
  const task = bridge.resumeBackground(target.room, event, target.session, () => admitted++);
  await enteredPromise;
  assert.equal(await bridge.resumeBackground(target.room, { ...event, event_id: '$other' }, target.session, () => admitted++), false);
  await hooks!.progress!('Inspecting saved results.');
  assert.deepEqual(replies, ['Inspecting saved results.']);
  await hooks!.background!({}, signal()); assert.equal(registered, 1);
  release(); assert.equal(await task, true); assert.equal(turns, 1); assert.equal(admitted, 1);
  await assert.rejects(hooks!.background!({}, signal()));
  await assert.rejects(hooks!.progress!('Too late'));
  state.reset(target.key);
  assert.equal(await bridge.resumeBackground(target.room, event, target.session, () => admitted++), false);
});

test('a user turn admitted during the privacy check defers the background turn', async t => {
  const f = setup(t), state = new State(join(f.root, 'sessions.json'));
  state.update(target.key, { codex: target.session });
  let unblock!: () => void, finish!: () => void;
  const privacy = new Promise<void>(r => unblock = r), running = new Promise<void>(r => finish = r);
  let checks = 0, turns = 0;
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 10_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => { if (++checks === 1) await privacy; return true; },
    reply: async () => {}, report, run: async () => { turns++; await running; return 'Done'; } });
  const background = bridge.resumeBackground(target.room, event, target.session, () => assert.fail('Must defer'));
  const user = bridge.handle(target.room, { ...event, event_id: '$human' });
  await new Promise(r => setImmediate(r));
  unblock(); assert.equal(await background, false);
  finish(); await user; assert.equal(turns, 1);
});

test('timers wait until due, survive restart and deliver once as a reminder or a room message', async t => {
  const f = setup(t), posts: string[] = [], reminders: string[] = [];
  const remind = (deliver: string, extra: object) => JSON.parse(f.queue.action({ action: 'remind', label: 'Check', message: 'Line one\nline two', deliver, ...extra }, target, signal()));
  const room = remind('room', { delay_minutes: 5 });
  const agent = remind('agent', { at: new Date(Date.now() + 10 * 60_000).toISOString() });
  const options = { valid: () => true, report,
    post: async (_t: BackgroundTarget, text: string, admit: () => void) => { admit(); posts.push(text); return true; },
    deliver: async (destination: BackgroundTarget, message: MatrixEvent, admit: () => void) => {
      admit(); reminders.push(message.content!.body!);
      assert.equal(sessionKey(destination.room, message), target.key);
      return true;
    } };
  const queue = new BackgroundTasks(f.file, f.root);
  await queue.pump(options);
  assert.deepEqual([posts.length, reminders.length], [0, 0]);
  await queue.pump(options, Date.now() + 6 * 60_000);
  assert.deepEqual(posts, ['Line one\nline two']);
  assert.equal(reminders.length, 0);
  await queue.pump(options, Date.now() + 11 * 60_000);
  await new BackgroundTasks(f.file, f.root).pump(options, Date.now() + 12 * 60_000);
  assert.equal(posts.length, 1); assert.equal(reminders.length, 1);
  assert.match(reminders[0], /not a new human instruction[^]*"label":"Check"/);
  const states = JSON.parse(queue.action({ action: 'list' }, target, signal()));
  assert.deepEqual(states.map((s: { id: string; state: string }) => [s.id, s.state]), [[room.id, 'delivered'], [agent.id, 'delivered']]);
  assert.match(queue.summary(target.key, target.session), /0 timers pending/);
});

test('timer input is bounded and cancellable, and a late timer arrives with its delay', async t => {
  const f = setup(t);
  const base = { action: 'remind', label: 'Later', message: 'Hello', deliver: 'room' };
  for (const bad of [{ ...base }, { ...base, delay_minutes: 0 }, { ...base, delay_minutes: 10081 }, { ...base, delay_minutes: 5, at: new Date().toISOString() },
    { ...base, at: '2026-10-04 10:00' }, { ...base, at: new Date(Date.now() - 60_000).toISOString() }, { ...base, deliver: 'everyone', delay_minutes: 5 },
    { ...base, message: '', delay_minutes: 5 }, { ...base, delay_minutes: 5, extra: true }]) {
    assert.throws(() => f.queue.action(bad, target, signal()), /Use remind/);
  }
  const cancelled = JSON.parse(f.queue.action({ ...base, delay_minutes: 5 }, target, signal()));
  assert.equal(JSON.parse(f.queue.action({ action: 'cancel', id: cancelled.id }, target, signal())).state, 'cancelled');
  const scheduled = JSON.parse(f.queue.action({ ...base, delay_minutes: 5 }, target, signal()));
  // The confirmation shows what will be sent and where.
  assert.deepEqual([scheduled.room, scheduled.message, scheduled.deliver], [target.room, 'Hello', 'room']);
  // A refusal (busy bot, changed room privacy) keeps it pending; later it arrives marked late.
  await f.queue.pump({ valid: () => true, report, deliver: async () => false, post: async () => false }, Date.now() + 6 * 60_000);
  assert.match(f.queue.summary(target.key, target.session), /1 timers pending/);
  const late: string[] = [];
  await f.queue.pump({ valid: () => true, report, deliver: async () => false,
    post: async (_t, text, admit) => { admit(); late.push(text); return true; } }, Date.now() + 65 * 60_000);
  assert.match(late[0], /^Hello\n\n\(Scheduled for .*; delivered 6\d minutes late\.\)$/);
  assert.match(f.queue.summary(target.key, target.session), /0 timers pending/);
});

test('finished timers are pruned so the saved state always loads again', async t => {
  const f = setup(t);
  for (let i = 0; i < 201; i++) {
    const { id } = JSON.parse(f.queue.action({ action: 'remind', label: 'Loop', message: 'x', deliver: 'room', delay_minutes: 5 }, target, signal()));
    f.queue.action({ action: 'cancel', id }, target, signal());
  }
  assert.ok(JSON.parse(new BackgroundTasks(f.file, f.root).action({ action: 'list' }, target, signal())).length <= 100);
});

test('a timer cancelled, reset or revoked during the room check is not sent', async t => {
  for (const change of ['cancel', 'reset'] as const) {
    const f = setup(t);
    let valid = true, release!: () => void;
    const { id } = JSON.parse(f.queue.action({ action: 'remind', label: 'Race', message: 'x', deliver: 'room', delay_minutes: 5 }, target, signal()));
    const sent: string[] = [];
    const pump = f.queue.pump({ valid: () => valid, report, deliver: async () => false,
      // Mirrors the connector: await the privacy check, then recheck before admission.
      post: async (_t, text, admit, ready) => {
        await new Promise<void>(r => { release = r; });
        if (!ready()) return false;
        admit(); sent.push(text); return true;
      } }, Date.now() + 6 * 60_000);
    await new Promise(r => setImmediate(r));
    if (change === 'cancel') assert.equal(JSON.parse(f.queue.action({ action: 'cancel', id }, target, signal())).state, 'cancelled');
    else valid = false;
    release(); await pump;
    assert.deepEqual(sent, []);
  }
  // The agent path rechecks the same condition before admitting the turn.
  const f = setup(t), state = new State(join(f.root, 'state.json'));
  state.update(target.key, { codex: target.session });
  let runs = 0;
  const bridge = new Bridge({ botId: '@bot:test', owner: target.sender, kind: 'codex', state, since: 0, timeoutMs: 1000,
    isAuthorized: () => true, isPrivateRoom: async () => true, reply: async () => {}, report,
    run: async () => { runs++; return 'done'; } });
  const timerEvent: MatrixEvent = { ...event, event_id: '$timer', content: { ...event.content!, body: 'Reminder' } };
  assert.equal(await bridge.resumeBackground(target.room, timerEvent, target.session, () => assert.fail('Must not admit'), () => false), false);
  assert.equal(runs, 0);
});


test('stale watches track valid writes across restarts, then notify once even if the file disappears', async t => {
  const f = setup(t), start = Date.now();
  f.queue.action({ ...input, stale_after_minutes: 5 }, target, signal());
  const received: string[] = [];
  const options = { valid: () => true, report, deliver: async (_t: BackgroundTarget, message: MatrixEvent, admit: () => void) => {
    admit(); received.push(message.content!.body!); return true;
  } };
  const file = join(f.root, 'status.json');
  f.status('building');
  const heartbeat = new Date(start + 4 * 60_000);
  utimesSync(file, heartbeat, heartbeat);
  await f.queue.pump(options, start + 4 * 60_000);
  const queue = new BackgroundTasks(f.file, f.root);
  rmSync(file);
  await queue.pump(options, start + 8 * 60_000);
  assert.equal(received.length, 0);
  await queue.pump(options, start + 10 * 60_000);
  await new BackgroundTasks(f.file, f.root).pump(options, start + 11 * 60_000);
  assert.equal(received.length, 1);
  assert.match(received[0], /"status":"watch_stalled"/);
  assert.match(received[0], /may still be running/);
});

test('malformed writes do not refresh liveness, busy delivery can recover to terminal completion', async t => {
  const f = setup(t), start = Date.now();
  f.queue.action({ ...input, stale_after_minutes: 1 }, target, signal());
  writeFileSync(join(f.root, 'status.json'), '{partial');
  let deferred = false;
  await f.queue.pump({ valid: () => true, report, deliver: async (_t, message) => {
    assert.match(message.content!.body!, /"status":"watch_stalled"/); deferred = true; return false;
  } }, start + 2 * 60_000);
  assert.equal(deferred, true);
  f.status('complete');
  await f.queue.pump({ valid: () => true, report, deliver: async (_t, message, admit) => {
    assert.match(message.content!.body!, /"status":"complete"/); admit(); return true;
  } }, start + 3 * 60_000);
});

test('PID checks survive restart, treat EPERM as unknown and prefer terminal status to a missing process', async t => {
  const f = setup(t);
  let code = 'EPERM';
  t.mock.method(process, 'kill', (pid: number, sig: number) => {
    assert.equal(pid, 12345); assert.equal(sig, 0);
    if (code) throw Object.assign(new Error('probe'), { code });
    return true;
  });
  f.queue.action({ ...input, pid: 12345 }, target, signal());
  const queue = new BackgroundTasks(f.file, f.root), received: string[] = [];
  const options = { valid: () => true, report, deliver: async (_t: BackgroundTarget, message: MatrixEvent, admit: () => void) => {
    admit(); received.push(message.content!.body!); return true;
  } };
  await queue.pump(options); code = ''; await queue.pump(options);
  assert.equal(received.length, 0);
  code = 'ESRCH'; await queue.pump(options); await new BackgroundTasks(f.file, f.root).pump(options);
  assert.equal(received.length, 1);
  assert.match(received[0], /"pid":12345,"status":"watch_process_missing"/);
  assert.match(received[0], /child processes may still be running/);
  queue.action({ ...input, pid: 12345, stale_after_minutes: 1 }, target, signal());
  f.status('complete');
  await queue.pump(options, Date.now() + 2 * 60_000);
  assert.match(received[1], /"status":"complete"/);
});

test('diagnostic watch options are bounded, visible and cannot silently change an existing watch', t => {
  const f = setup(t);
  for (const bad of [{ pid: 0 }, { pid: -1 }, { pid: 1.1 }, { pid: 2147483648 }, { pid: '123' },
    { stale_after_minutes: 0 }, { stale_after_minutes: 10081 }, { stale_after_minutes: 1.1 }]) {
    assert.throws(() => f.queue.action({ ...input, ...bad }, target, signal()));
  }
  const options = { ...input, pid: 12345, stale_after_minutes: 5 };
  const first = JSON.parse(f.queue.action(options, target, signal()));
  assert.equal(JSON.parse(f.queue.action(options, target, signal())).id, first.id);
  assert.throws(() => f.queue.action({ ...options, pid: 12346 }, target, signal()), /different PID/);
  assert.throws(() => f.queue.action({ ...options, stale_after_minutes: 10 }, target, signal()), /different stale timeout/);
  const listed = JSON.parse(f.queue.action({ action: 'list' }, target, signal()))[0];
  assert.equal(listed.pid, 12345); assert.equal(listed.stale_after_minutes, 5);
  assert.ok(Number.isFinite(Date.parse(listed.last_update)));
});


test('a real supervised process exiting without a terminal file wakes the watch', async t => {
  const f = setup(t);
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, 'spawn');
  f.queue.action({ ...input, pid: child.pid }, target, signal());
  await f.queue.pump({ valid: () => true, report, deliver: async () => assert.fail('Process still alive') });
  const exited = once(child, 'exit'); child.kill(); await exited;
  let delivered = false;
  await new BackgroundTasks(f.file, f.root).pump({ valid: () => true, report, deliver: async (_t, message, admit) => {
    assert.match(message.content!.body!, /"status":"watch_process_missing"/);
    admit(); delivered = true; return true;
  } });
  assert.equal(delivered, true);
});
