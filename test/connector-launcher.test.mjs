import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('manual startup replaces only the verified instance and waits for shutdown', { timeout: 60_000 }, () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./connector_launcher_test.py', import.meta.url))], {
    env: { ...process.env, LAUNCHER_TEST_NODE: process.execPath, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8', timeout: 55_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));

test('start, restart and npm entry point replace a real supervisor and locked child', { timeout: 60_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-start-e2e-')));
  const code = join(root, 'code with spaces');
  mkdirSync(join(code, 'scripts'), { recursive: true });
  mkdirSync(join(code, 'src'));
  for (const name of ['start-connector.sh', 'restart-supervisor.sh', 'connector-launcher.py', 'run.mjs']) {
    copyFileSync(join(source, 'scripts', name), join(code, 'scripts', name));
  }
  symlinkSync(join(source, 'node_modules'), join(code, 'node_modules'));
  writeFileSync(join(code, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, '.env'), 'DATA_DIR=./runtime\n');
  const events = () => { try { return readFileSync(join(root, 'events'), 'utf8').trim().split('\n'); } catch { return []; } };
  writeFileSync(join(code, 'src/main.ts'), `
import { lockInstance } from ${JSON.stringify(new URL('../src/instance-lock.ts', import.meta.url).href)};
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--check-config')) process.exit(process.env.BAD_CONFIG ? 78 : 0);
const release = lockInstance(process.env.DATA_DIR);
appendFileSync('events', 'start ' + process.pid + '\\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  appendFileSync('events', 'stop ' + process.pid + '\\n');
  release(); process.exit(0);
});
`);
  writeFileSync(join(code, 'src/supervisor.ts'), `
import { supervise } from ${JSON.stringify(new URL('../src/supervisor.ts', import.meta.url).href)};
import { fileURLToPath, pathToFileURL } from 'node:url';
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await supervise({ args: ['--env-file-if-exists=.env', '--import',
    fileURLToPath(import.meta.resolve('tsx')), fileURLToPath(new URL('./main.ts', import.meta.url))] });
}
`);
  const env = { ...process.env, RIFTJACK_HOME: root, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.DATA_DIR;
  delete env.BAD_CONFIG;
  // Cleanup only processes whose command and cwd identify this test's temporary instance.
  t.after(async () => {
    try {
      await execute('python3', ['-c',
        'import sys; sys.path.insert(0, sys.argv[1]); import importlib; importlib.import_module("connector-launcher").replace_instance(sys.argv[2], sys.argv[3])',
        join(code, 'scripts'), root, process.execPath], { env, timeout: 15_000 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const run = name => execute('sh', [join(code, 'scripts', name)], { cwd: root, env, timeout: 15_000 });
  await run('start-connector.sh');
  const first = events();
  assert.equal(first.length, 1);
  assert.match(first[0], /^start \d+$/);
  // Failed preflight must leave the working instance alive and holding its lock.
  writeFileSync(join(root, '.env'), 'DATA_DIR=./runtime\nBAD_CONFIG=1\n');
  await assert.rejects(run('start-connector.sh'), error => error.code === 78);
  assert.deepEqual(events(), first);
  process.kill(Number(first[0].split(' ')[1]), 0);
  writeFileSync(join(root, '.env'), 'DATA_DIR=./runtime\n');
  await run('restart-supervisor.sh');
  const second = events();
  assert.equal(second.length, 3);
  assert.equal(second[1], first[0].replace('start', 'stop'));
  assert.match(second[2], /^start \d+$/);
  assert.notEqual(second[2], first[0]);
  // This is the same run.mjs entry used by npm start, kept in the foreground.
  const foreground = spawn(process.execPath, [join(code, 'scripts/run.mjs'), 'supervisor'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  foreground.stdout.on('data', chunk => { output += chunk; });
  foreground.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => foreground.on('close', resolve));
  t.after(() => { if (foreground.exitCode === null) foreground.kill('SIGTERM'); });
  const deadline = Date.now() + 15_000;
  while (events().length < 5 && Date.now() < deadline && foreground.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(events().length, 5, output);
  assert.equal(events()[3], second[2].replace('start', 'stop'));
  foreground.kill('SIGTERM');
  assert.equal(await closed, 0, output);
  assert.equal(events()[5], events()[4].replace('start', 'stop'));
});
