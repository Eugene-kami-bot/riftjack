// One detached supervisor per accepted job. It has no Matrix token or model access.
import { spawn } from 'node:child_process';
import { readFileSync, openSync, closeSync, writeSync, existsSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { saveJson, syncDirectory } from './executor-storage.mjs';

process.umask(0o077);
const dir = process.argv[2];
// An exclusive claim prevents even an accidentally duplicated launch from executing twice.
try {
  const claim = openSync(join(dir, 'claimed'), 'wx', 0o600);
  try { fsyncSync(claim); } finally { closeSync(claim); }
  syncDirectory(dir);
} catch { process.exit(1); }
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const state = { status: 'running', pid: process.pid, started: Date.now(), updated: Date.now(), bytes: 0 };
const save = () => { state.updated = Date.now(); saveJson(join(dir, 'result.json'), state); };
if (existsSync(join(dir, 'cancel'))) {
  Object.assign(state, { status: 'cancelled', finished: Date.now() }); save(); process.exit(0);
}
save();
const log = openSync(join(dir, 'output.log'), 'a', 0o600);
let child, done = false, reason, killTimer;
const terminate = why => {
  if (done || reason) return;
  reason = why;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
};
const finish = (code, signal, error) => {
  if (done) return;
  done = true; clearInterval(poll); clearTimeout(killTimer);
  // End any ordinary descendants that kept running after the direct child exited.
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  Object.assign(state, { status: reason || (error || code !== 0 ? 'failed' : 'succeeded'), code, signal, error, finished: Date.now() });
  fsyncSync(log); save(); closeSync(log);
};
const output = (stream, buffer) => {
  const prefix = Buffer.from(`[${stream}] `), remaining = spec.maxLogBytes - state.bytes;
  if (remaining <= 0) { terminate('output_limit'); return; }
  const data = Buffer.concat([prefix, buffer]).subarray(0, remaining);
  writeSync(log, data); state.bytes += data.length;
  if (state.bytes >= spec.maxLogBytes) terminate('output_limit');
};
child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => output('stdout', b));
child.stderr.on('data', b => output('stderr', b));
child.on('error', e => finish(null, null, e.code || 'spawn failed'));
child.on('close', (code, signal) => finish(code, signal));
const poll = setInterval(() => {
  if (existsSync(join(dir, 'cancel'))) terminate('cancelled');
  if (Date.now() - state.started >= spec.timeoutSeconds * 1000) terminate('timed_out');
  if (Date.now() - state.updated >= 5000) { fsyncSync(log); save(); }
}, 250);
process.on('SIGTERM', () => terminate('cancelled'));
process.on('SIGINT', () => terminate('cancelled'));
