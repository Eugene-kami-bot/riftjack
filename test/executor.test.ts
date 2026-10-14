import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { bindExecutorInbox } from '../src/executor-main.js';
import { fileURLToPath } from 'node:url';
import { ExecutorQueue, saveExecutorJson, type ExecutorPost, type ExecutorTransport } from '../src/executor-queue.js';
import { executorPolicy, parseExecutorRequest, executorRoomAllowed } from '../src/executor-protocol.js';
const bot = '@executor:test', sender = '@alice:test', room = '!lab:test';
const pause = () => new Promise(r => setTimeout(r, 30));
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'executor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), dir = join(root, 'state'); mkdirSync(workspace); mkdirSync(dir);
  const policy = executorPolicy({ workspace, mode: 'limited', senders: [sender], rooms: [room], sudoActions: { inspect: ['/usr/bin/id'] } });
  let seq = 0;
  const event = (request: object) => ({ type: 'm.room.message', event_id: '$' + ++seq, sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: `!exec ${bot} ${JSON.stringify(request)}` } });
  const run = (id = 'one', source = 'console.log("hello"); console.error("world")') => ({ action: 'run', id, argv: [process.execPath, '-e', source], timeoutSeconds: 5 });
  const posts: ExecutorPost[] = [];
  const transport: ExecutorTransport = { allowed: async () => true, prepare: async p => ({ text: p.body }), send: async p => { posts.push(structuredClone(p)); } };
  const saved = () => JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'));
  return { root, workspace, dir, policy, event, run, posts, transport, saved };
}

test('executor requires explicit addressing, strict requests and owner-selected privilege mode', t => {
  const f = fixture(t), parse = (r: object) => parseExecutorRequest(`!exec ${bot} ${JSON.stringify(r)}`, bot, f.policy);
  assert.equal(parseExecutorRequest('please run /bin/true', bot, f.policy), undefined);
  assert.equal(parseExecutorRequest('!exec @different:test {}', bot, f.policy), undefined);
  assert.throws(() => parse({ ...f.run(), sudo: true }), /disabled/);
  const full = { ...f.policy, mode: 'full' as const };
  assert.deepEqual((parseExecutorRequest(`!exec ${bot} ${JSON.stringify({ ...f.run(), sudo: true })}`, bot, full) as any).argv.slice(0, 3), ['/usr/bin/sudo', '-n', '--']);
  assert.deepEqual((parse({ action: 'run', id: 'sudo', sudoAction: 'inspect' }) as any).argv, ['/usr/bin/sudo', '-n', '--', '/usr/bin/id']);
  assert.throws(() => parse({ ...f.run(), sudoAction: 'inspect' }), /without/);
  for (const bad of [{ ...f.run(), mode: 'full' }, { ...f.run(), id: '../x' }, { ...f.run(), timeoutSeconds: 86401 },
    { ...f.run(), argv: ['sh'] }, { ...f.run(), argv: ['/bin/sh', '\0'] }, { action: 'cancel', id: 'one', extra: true }]) assert.throws(() => parse(bad));
  symlinkSync(f.root, join(f.workspace, 'outside'));
  assert.throws(() => parse({ ...f.run(), cwd: 'outside' }), /inside/);
});

test('executor room must remain encrypted, invite-only, joined-history with the requester present', t => {
  const f = fixture(t);
  const state = [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...[bot, sender, '@observer:test'].map(id => ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } })),
  ];
  assert.equal(executorRoomAllowed(state, bot, sender, f.policy), true);
  assert.equal(executorRoomAllowed(state.slice(1), bot, sender, f.policy), false);
  assert.equal(executorRoomAllowed(state, bot, '@observer:test', f.policy), false);
  assert.equal(executorRoomAllowed(state.filter(e => e.state_key !== sender), bot, sender, f.policy), false);
});

test('durable admission deduplicates events and job IDs; ignores strangers, wrong rooms, edits and old messages', async t => {
  const f = fixture(t), launches: string[] = [];
  let q = new ExecutorQueue(f.dir, bot, f.policy, dir => { launches.push(dir); });
  const e = f.event(f.run());
  await q.receive(room, { ...e, sender: '@stranger:test' }, f.transport.allowed);
  await q.receive('!other:test', e, f.transport.allowed);
  await q.receive(room, { ...e, origin_server_ts: 1 }, f.transport.allowed);
  await q.receive(room, { ...e, content: { ...e.content, 'm.relates_to': { rel_type: 'm.replace' } } }, f.transport.allowed);
  assert.equal(f.saved().jobs.length, 0);
  await q.receive(room, e, f.transport.allowed);
  q = new ExecutorQueue(f.dir, bot, f.policy, dir => { launches.push(dir); });
  await q.receive(room, e, f.transport.allowed);
  await q.receive(room, f.event(f.run()), f.transport.allowed);
  await q.receive(room, f.event(f.run('one', 'different')), f.transport.allowed);
  assert.equal(f.saved().jobs.length, 1);
  await q.tick(f.transport);
  q = new ExecutorQueue(f.dir, bot, f.policy, dir => { launches.push(dir); });
  await q.tick(f.transport);
  assert.equal(launches.length, 1);
  assert.equal(f.saved().jobs[0].state, 'uncertain');
  assert.ok(f.saved().outbox.some((p: ExecutorPost) => p.body.includes('different request')));
});

test('outbox reuses the same encrypted event and transaction after uncertain delivery and restart', async t => {
  const f = fixture(t), q = new ExecutorQueue(f.dir, bot, f.policy, () => {});
  await q.receive(room, f.event(f.run()), f.transport.allowed);
  let attempted: ExecutorPost | undefined;
  await assert.rejects(q.tick({ ...f.transport, send: async p => { attempted = structuredClone(p); throw new Error('connection lost after acceptance'); } }));
  const recovered = new ExecutorQueue(f.dir, bot, f.policy, () => assert.fail('Must not relaunch'));
  await recovered.tick({ ...f.transport, prepare: async () => assert.fail('Must reuse saved ciphertext') });
  assert.deepEqual(f.posts[0], attempted);
});

test('queued cancellation and revoked access prevent launch', async t => {
  const f = fixture(t), q = new ExecutorQueue(f.dir, bot, f.policy, () => assert.fail('Must not launch'));
  await q.receive(room, f.event(f.run()), f.transport.allowed);
  await q.receive(room, f.event({ action: 'cancel', id: 'one' }), f.transport.allowed);
  await q.tick(f.transport);
  await q.receive(room, f.event(f.run('two')), f.transport.allowed);
  await q.tick({ ...f.transport, allowed: async () => false });
  assert.deepEqual(f.saved().jobs.map((j: any) => j.state), ['cancelled', 'cancelled']);
});

test('runner produces stdout/stderr, survives connector replacement, excludes credentials and runs jobs serially', async t => {
  const f = fixture(t);
  const q = new ExecutorQueue(f.dir, bot, f.policy);
  await q.receive(room, f.event(f.run('one', 'console.log(process.env.MATRIX_ACCESS_TOKEN ?? "clean");setTimeout(()=>console.error("finished"), 350)')), f.transport.allowed);
  await q.receive(room, f.event(f.run('two')), f.transport.allowed);
  await q.tick(f.transport);
  const recovered = new ExecutorQueue(f.dir, bot, f.policy);
  let sawRunning = false;
  for (let i = 0; i < 150; i++) {
    await pause(); await recovered.tick(f.transport);
    const jobs = f.saved().jobs;
    assert.ok(jobs.filter((j: any) => ['running', 'starting', 'uncertain'].includes(j.state)).length <= 1);
    sawRunning ||= jobs[0].state === 'running';
    if (jobs.every((j: any) => j.state === 'succeeded') && f.saved().outbox.length === 0) break;
  }
  assert.equal(sawRunning, true);
  assert.deepEqual(f.saved().jobs.map((j: any) => j.state), ['succeeded', 'succeeded']);
  const first = f.saved().jobs[0];
  const log = readFileSync(join(first.dir, 'output.log'), 'utf8');
  assert.match(log, /\[stdout\] clean/); assert.match(log, /\[stderr\] finished/);
  assert.ok(f.posts.some(p => p.body.includes('Output bytes')));
  assert.ok(f.posts.some(p => p.file?.endsWith('output.log')));
  await recovered.receive(room, f.event({ action: 'log', id: 'one' }), f.transport.allowed);
  await recovered.tick(f.transport);
  assert.equal(readFileSync(f.posts.at(-1)!.file!, 'utf8'), log);
});

for (const reason of ['cancelled', 'timed_out'] as const) test(`runner terminates a ${reason} task`, async t => {
  const f = fixture(t), q = new ExecutorQueue(f.dir, bot, f.policy);
  await q.receive(room, f.event({ ...f.run('one', 'setInterval(()=>console.log("alive"), 50)'), timeoutSeconds: reason === 'timed_out' ? 1 : 5 }), f.transport.allowed);
  await q.tick(f.transport);
  if (reason === 'cancelled') await q.receive(room, f.event({ action: 'cancel', id: 'one' }), f.transport.allowed);
  for (let i = 0; i < 150; i++) { await pause(); await q.tick(f.transport); if (f.saved().jobs[0].state === reason) break; }
  assert.equal(f.saved().jobs[0].state, reason);
});

test('runner rejects duplicate launches and bounds output', async t => {
  const f = fixture(t), dir = join(f.dir, 'runner'); mkdirSync(dir);
  saveExecutorJson(join(dir, 'spec.json'), { argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'], cwd: f.workspace, env: {}, timeoutSeconds: 5, maxLogBytes: 4096 });
  const runner = fileURLToPath(new URL('../scripts/executor-runner.mjs', import.meta.url));
  const first = spawn(process.execPath, [runner, dir], { stdio: 'ignore' });
  await once(first, 'close');
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).status, 'output_limit');
  assert.equal(readFileSync(join(dir, 'output.log')).length, 4096);
  const second = spawn(process.execPath, [runner, dir], { stdio: 'ignore' });
  const [code] = await once(second, 'close'); assert.equal(code, 1);
});

test('Matrix wiring admits only decrypted messages and awaits the durable inbox write', async t => {
  const f = fixture(t), client = new EventEmitter() as EventEmitter & { inbox?: (room: string, event: unknown) => Promise<void> };
  let calls = 0, release!: () => void;
  bindExecutorInbox(client as any, { receive: async () => { calls++; await new Promise<void>(r => { release = r; }); } }, f.transport.allowed);
  const e = f.event(f.run());
  await client.inbox!(room, e); assert.equal(calls, 0);
  client.emit('room.decrypted_event', room, e);
  let completed = false;
  const delivery = client.inbox!(room, e).then(() => { completed = true; });
  await pause(); assert.equal(completed, false); assert.equal(calls, 1);
  release(); await delivery; assert.equal(completed, true);
});

test('changing owner policy cancels previously queued work instead of retaining old sudo rights', async t => {
  const f = fixture(t);
  const before = new ExecutorQueue(f.dir, bot, { ...f.policy, mode: 'full' }, () => assert.fail('Must not launch'));
  await before.receive(room, f.event({ ...f.run(), sudo: true }), f.transport.allowed);
  const after = new ExecutorQueue(f.dir, bot, f.policy, () => assert.fail('Must not launch'));
  await after.tick(f.transport);
  assert.equal(f.saved().jobs[0].state, 'cancelled');
});

test('launch happens only after request and starting state have been saved; failed save prevents launch', async t => {
  const f = fixture(t);
  let launches = 0;
  const q = new ExecutorQueue(f.dir, bot, f.policy, dir => {
    launches++;
    assert.equal(f.saved().jobs[0].state, 'starting');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')).argv, f.run().argv);
  });
  await q.receive(room, f.event(f.run()), f.transport.allowed);
  mkdirSync(join(f.dir, 'queue.json.tmp'));
  await assert.rejects(q.tick(f.transport));
  assert.equal(launches, 0);
  assert.equal(f.saved().jobs[0].state, 'queued');
  rmSync(join(f.dir, 'queue.json.tmp'), { recursive: true });
  // Recover from the durable queued record, not the failed in-memory transition.
  const restored = new ExecutorQueue(f.dir, bot, f.policy, dir => {
    launches++;
    assert.equal(f.saved().jobs[0].state, 'starting');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8')).argv, f.run().argv);
  });
  await restored.tick(f.transport); assert.equal(launches, 1);
});

test('standalone entry validates an executor instance without a model account or network', async t => {
  const f = fixture(t), policy = join(f.root, 'policy.json');
  writeFileSync(policy, JSON.stringify(f.policy));
  writeFileSync(join(f.root, '.env'), [
    'MATRIX_HOMESERVER=https://invalid.test', `MATRIX_USER_ID=${bot}`, 'MATRIX_ACCESS_TOKEN=fixture-only',
    `EXECUTOR_POLICY=${policy}`, `EXECUTOR_DATA_DIR=${f.dir}`,
  ].join('\n'));
  const entry = fileURLToPath(new URL('../scripts/run.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, 'executor-main', '--check-config'], { cwd: f.root,
    env: { PATH: process.env.PATH, RIFTJACK_HOME: f.root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, text); assert.match(text, /configuration valid; mode limited/);
});

test('progress wakes require new output and requested interval; restart keeps the deadline, completion bypasses it', async t => {
  const f = fixture(t);
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let q = new ExecutorQueue(f.dir, bot, f.policy, () => {});
  await q.receive(room, f.event({ ...f.run(), wakeIntervalSeconds: 60 }), f.transport.allowed);
  await q.tick(f.transport);
  const dir = f.saved().jobs[0].dir;
  const step = async (seconds: number, output: string, status = 'running') => {
    now += seconds * 1000;
    writeFileSync(join(dir, 'output.log'), output);
    saveExecutorJson(join(dir, 'result.json'), { status, updated: now, started: now - seconds * 1000, code: status === 'succeeded' ? 0 : null });
    for (let i = 0; i < 5; i++) await q.tick(f.transport);
  };
  const wakes = () => f.posts.filter(p => p.wake?.reason === 'progress');
  await step(59, 'first'); assert.equal(wakes().length, 0);
  q = new ExecutorQueue(f.dir, bot, f.policy, () => assert.fail('Must not relaunch'));
  await step(1, 'first'); assert.equal(wakes().length, 1);
  await step(60, 'first'); assert.equal(wakes().length, 1, 'quiet job does not wake');
  await step(1, 'first\nsecond'); assert.equal(wakes().length, 2);
  await step(1, 'first\nsecond\nthird'); assert.equal(wakes().length, 2);
  await step(1, 'first\nsecond\nthird', 'succeeded');
  assert.equal(f.posts.filter(p => p.wake?.reason === 'completed').length, 1);
  assert.equal(wakes().length, 2);
  for (const value of [-1, 1, 9, 86401, 1.5, '60']) assert.throws(() => parseExecutorRequest(`!exec ${bot} ${JSON.stringify({ ...f.run(), wakeIntervalSeconds: value })}`, bot, f.policy));
});
