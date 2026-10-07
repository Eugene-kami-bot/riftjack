import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { State } from '../src/state.js';
import { contextCheckpoints, checkpointDelivery, claudeCheckpointHooks } from '../src/context-checkpoints.js';

test('Claude compact hook emits the matching session note without reading files or interpreting paths as shell code', t => {
  const f = setup(t);
  const workspace = join(f.dir, "space ' quote $HOME `exit 7` $(exit 8)");
  const hooks = claudeCheckpointHooks(workspace);
  const hook = hooks.SessionStart[0];
  assert.equal(hook.matcher, 'compact');
  assert.equal('async' in hook.hooks[0], false);
  const run = (input: unknown) => spawnSync('/bin/sh', ['-c', hook.hooks[0].command], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  const event = { hook_event_name: 'SessionStart', source: 'compact', session_id: 'session', cwd: '/ignored' };
  const result = run(event);
  assert.equal(result.status, 0, result.stderr);
  const c = contextCheckpoints(f.state, 'hook', 'claude', workspace, event.session_id);
  c.start(); c.complete();
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: c.notice()!.text } });
  for (const update of [{ source: 'resume' }, { source: 'startup' }, { hook_event_name: 'PreCompact' }, { session_id: '../other' }]) {
    const skipped = run({ ...event, ...update });
    assert.equal(skipped.status, 0); assert.equal(skipped.stdout, '');
  }
  const invalid = run('{private-malformed-input');
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.doesNotMatch(invalid.stderr, /private-malformed/);
});

function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const state = new State(file);
  return { dir, file, state, checkpoint: contextCheckpoints(state, 'key', 'codex', dir, 'session') };
}

test('warn once per window, preserve pending across restart and isolate session/backend', t => {
  const f = setup(t), c = f.checkpoint;
  c.usage(129999, 200000); assert.equal(c.notice(), undefined);
  c.usage(130000, 200000); const note = c.notice()!; assert.match(note.text, /65%/);
  const resumed = contextCheckpoints(new State(f.file), 'key', 'codex', f.dir, 'session');
  assert.deepEqual(resumed.notice(), note);
  resumed.delivered(note.id); resumed.usage(199999, 200000); assert.equal(resumed.notice(), undefined);
  assert.equal(contextCheckpoints(f.state, 'key', 'claude', f.dir, 'session').notice(), undefined);
  assert.equal(contextCheckpoints(f.state, 'key', 'codex', f.dir, 'new-session').notice(), undefined);
});

test('unknown and malformed measurements never produce a warning', t => {
  const c = setup(t).checkpoint;
  for (const [used, size] of [[100, null], [NaN, 200], [100, 0], [-1, 200], [Infinity, 200], [100, '200'], [10.5, 12]]) c.usage(used, size);
  assert.equal(c.notice(), undefined);
});

test('only matching Claude hook output acknowledges restoration, before or after the boundary', t => {
  const f = setup(t);
  const c = contextCheckpoints(f.state, 'claude', 'claude', f.dir, 'session');
  c.start(); c.complete(); const note = c.notice()!;
  c.restored('another hook'); assert.deepEqual(c.notice(), note);
  c.restored(note.text); assert.equal(c.notice(), undefined);
  c.start(); c.restored(note.text); c.complete(); assert.equal(c.notice(), undefined);
  c.start(); c.complete(); assert.match(c.notice()!.text, /compaction completed/);
  const other = contextCheckpoints(f.state, 'other', 'claude', f.dir, 'other-session');
  other.start(); other.complete(); other.restored(note.text); assert.ok(other.notice());
});

test('compaction replaces a queued warning and old acknowledgement cannot erase restore', t => {
  const c = setup(t).checkpoint;
  c.complete(); assert.equal(c.notice(), undefined); // replayed boundary
  c.usage(150, 200); const old = c.notice()!;
  c.start(); assert.equal(c.notice(), undefined);
  c.usage(199, 200); c.complete(); const restore = c.notice()!;
  assert.match(restore.text, /compaction completed/);
  c.delivered(old.id); assert.deepEqual(c.notice(), restore);
  c.complete(); assert.deepEqual(c.notice(), restore);
  c.delivered(restore.id); c.usage(20, 200); assert.equal(c.notice(), undefined);
  c.usage(150, 200); assert.notEqual(c.notice()!.id, old.id);
});

test('Claude measures one request including cache, using only matching reported window', t => {
  const f = setup(t), c = contextCheckpoints(f.state, 'key', 'claude', f.dir, 'claude-session');
  c.claudeUsage('model-a', { input_tokens: 10000, cache_read_input_tokens: 120000 });
  assert.equal(c.notice(), undefined); // capacity not yet reported
  c.claudeCapacity({ 'other-model': { contextWindow: 200000 } }); assert.equal(c.notice(), undefined);
  c.claudeCapacity({ 'model-a': { contextWindow: 200000 } }); assert.ok(c.notice());
  const note = c.notice()!; c.delivered(note.id); c.start(); c.complete(); c.delivered(c.notice()!.id);
  c.claudeUsage('model-a', { input_tokens: 1, cache_read_input_tokens: 100000 });
  c.claudeUsage('model-a', { input_tokens: 1, cache_read_input_tokens: 100000 });
  assert.equal(c.notice(), undefined); // not cumulative across steps
  c.claudeUsage('model-b', { input_tokens: 150000 }); assert.equal(c.notice(), undefined);
  c.claudeCapacity({ 'model-b': { contextWindow: 1000000 } }); assert.equal(c.notice(), undefined);
});

test('late or rejected steering leaves one advisory for the next input, no busy retry', async t => {
  const c = setup(t).checkpoint; c.usage(70, 100);
  let attempts = 0;
  const delivery = checkpointDelivery(c, async () => { attempts++; throw Error('already finished'); });
  delivery.flush(); delivery.flush(); await delivery.settled(); delivery.flush(); await delivery.settled();
  assert.equal(attempts, 1); assert.ok(c.notice());
});

test('queued save superseded by compaction is not delivered after restore', async t => {
  const c = setup(t).checkpoint, sent: string[] = [];
  const delivery = checkpointDelivery(c, async text => { sent.push(text); return true; });
  c.usage(70, 100); delivery.flush(); c.start(); c.complete(); delivery.flush(); await delivery.settled();
  assert.equal(sent.length, 1); assert.match(sent[0], /compaction completed/); assert.equal(c.notice(), undefined);
});
