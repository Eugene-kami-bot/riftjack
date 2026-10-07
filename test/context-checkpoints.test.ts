import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { contextCheckpoints, checkpointDelivery } from '../src/context-checkpoints.js';

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
