import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockInstance } from '../src/instance-lock.js';
import { CONFIG_EXIT_CODE } from '../src/restart.js';

const tsx = fileURLToPath(import.meta.resolve('tsx'));
const lockUrl = new URL('../src/instance-lock.ts', import.meta.url).href;
const holder = `
import { lockInstance, InstanceBusyError } from ${JSON.stringify(lockUrl)};
try {
  const release = lockInstance(process.argv[1]);
  process.on('message', message => { if (message === 'release') release(); process.exit(0); });
  process.send('locked');
} catch (error) {
  if (!(error instanceof InstanceBusyError)) throw error;
  process.send('busy', () => process.exit(${CONFIG_EXIT_CODE}));
}
`;

const cleanups = new WeakMap<TestContext, Array<() => Promise<void>>>();

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-lock-'));
  t.after(async () => {
    for (const stop of cleanups.get(t) || []) await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function start(t: TestContext, dir: string) {
  const child = spawn(process.execPath, ['--import', tsx, '--input-type=module', '-e', holder, dir],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Holder exited before reporting: ${stderr}`)));
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
  };
  if (!cleanups.has(t)) cleanups.set(t, []);
  cleanups.get(t)!.push(stop);
  return { child, ready, done };
}

test('stale, malformed and reused live PIDs do not prevent acquiring the lock', t => {
  const dir = directory(t);
  for (const stale of ['999999999', 'not a PID', String(process.pid)]) {
    writeFileSync(join(dir, 'connector.pid'), stale);
    const release = lockInstance(dir);
    try { assert.equal(readFileSync(join(dir, 'connector.pid'), 'utf8'), String(process.pid)); }
    finally { release(); }
    assert.equal(existsSync(join(dir, 'connector.pid')), false);
    assert.equal(existsSync(join(dir, 'connector.lock.sqlite')), true);
    release(); // Safe to release explicitly and later during process cleanup.
  }
});

test('simultaneous independent processes have exactly one owner', { timeout: 20_000 }, async t => {
  const dir = directory(t);
  const contenders = Array.from({ length: 6 }, () => start(t, dir));
  const states = await Promise.all(contenders.map(c => c.ready));
  assert.equal(states.filter(s => s === 'locked').length, 1);
  assert.equal(states.filter(s => s === 'busy').length, 5);
  const winner = contenders[states.indexOf('locked')];
  for (const c of contenders.filter(c => c !== winner)) assert.equal((await c.done).code, CONFIG_EXIT_CODE);
  assert.equal(readFileSync(join(dir, 'connector.pid'), 'utf8'), String(winner.child.pid));
  winner.child.send('stop');
  assert.equal((await winner.done).code, 0);
  assert.equal(existsSync(join(dir, 'connector.pid')), false);
  const replacement = start(t, dir);
  assert.equal(await replacement.ready, 'locked');
});

test('SIGKILL releases the OS lock even though the old PID file remains', { timeout: 20_000 }, async t => {
  const dir = directory(t);
  const first = start(t, dir);
  assert.equal(await first.ready, 'locked');
  const inode = statSync(join(dir, 'connector.lock.sqlite')).ino;
  first.child.kill('SIGKILL');
  assert.equal((await first.done).signal, 'SIGKILL');
  assert.equal(readFileSync(join(dir, 'connector.pid'), 'utf8'), String(first.child.pid));
  const replacement = start(t, dir);
  assert.equal(await replacement.ready, 'locked');
  assert.equal(readFileSync(join(dir, 'connector.pid'), 'utf8'), String(replacement.child.pid));
  assert.equal(statSync(join(dir, 'connector.lock.sqlite')).ino, inode);
});

test('different data directories can be used concurrently', { timeout: 20_000 }, async t => {
  const first = start(t, directory(t));
  const second = start(t, directory(t));
  assert.deepEqual(await Promise.all([first.ready, second.ready]), ['locked', 'locked']);
});

test('a failed PID write releases the lock and retains the filesystem error', t => {
  const dir = directory(t);
  mkdirSync(join(dir, 'connector.pid'));
  assert.throws(() => lockInstance(dir), { code: 'EISDIR' });
  rmSync(join(dir, 'connector.pid'), { recursive: true });
  lockInstance(dir)();
});

test('main reports lock contention with the supervisor no-retry exit code', { timeout: 20_000 }, async t => {
  const dir = directory(t);
  const owner = start(t, join(dir, 'data'));
  assert.equal(await owner.ready, 'locked');
  // Only configuration and lock acquisition run: no account or network access.
  const env = { PATH: process.env.PATH, MATRIX_HOMESERVER: 'https://matrix.example.test',
    MATRIX_OWNER_ID: '@owner:example.test', RIFTJACK_WORKSPACE: dir, DATA_DIR: join(dir, 'data') };
  const result = spawnSync(process.execPath,
    ['--import', tsx, fileURLToPath(new URL('../src/main.ts', import.meta.url))],
    { cwd: dir, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, CONFIG_EXIT_CODE, result.stderr);
  assert.match(result.stderr, /Another connector is using this data directory/);
  assert.equal(readFileSync(join(dir, 'data/connector.pid'), 'utf8'), String(owner.child.pid));
});
