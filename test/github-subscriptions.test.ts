import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { githubReader, GitHubSubscriptions, type GitHubRead } from '../src/github-subscriptions.js';
import { BackgroundTasks, type BackgroundTarget } from '../src/background-tasks.js';

test('a rate-limit response also delays requests already queued by another bot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-reader-review-'));
  const log = join(dir, 'calls.jsonl');
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({time:Date.now()})+'\\n');
process.stdout.write('HTTP/2.0 429 Too Many Requests\\nretry-after: 30\\n\\n{}');
process.exitCode = 1;
`, { mode: 0o700 });
  process.env.PATH = dir + ':' + oldPath;
  const controller = new AbortController();
  const policy = { ghConfigDir: dir, repositories: ['example/project'] };
  // Two real readers share a credentials directory, as supported by the owner configuration.
  // Both reserve their slots before the first subprocess returns Retry-After.
  const first = githubReader(policy)('repos/example/project/pulls/1', controller.signal).catch(() => {});
  const second = githubReader(policy)('repos/example/project/pulls/2', controller.signal).catch(() => {});
  await first;
  await new Promise(resolve => setTimeout(resolve, 1500));
  controller.abort();
  await second;
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.equal(calls.length, 1, 'queued request started inside the 30-second Retry-After period');
});

test('separate credentials proceed while another account is rate limited; queued cancellation is prompt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-accounts-'));
  const log = join(dir, 'calls.jsonl');
  const a = join(dir, 'account-a'), b = join(dir, 'account-b');
  mkdirSync(a); mkdirSync(b);
  const oldPath = process.env.PATH;
  const controller = new AbortController();
  t.after(() => { controller.abort(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({account:process.env.GH_CONFIG_DIR, args:process.argv.slice(2)})+${JSON.stringify('\n')});
if (process.env.GH_CONFIG_DIR === ${JSON.stringify(a)}) {
  process.stdout.write('HTTP/2.0 429 Too Many Requests\\nretry-after: 30\\n\\n{}'); process.exitCode = 1;
} else { process.stdout.write('HTTP/2.0 200 OK\\n\\n{"account":"b"}'); }
`, { mode: 0o700 });
  process.env.PATH = dir + ':' + oldPath;
  const ra = githubReader({ ghConfigDir: a, repositories: ['example/project'] });
  const rb = githubReader({ ghConfigDir: b, repositories: ['example/project'] });
  await assert.rejects(ra('repos/example/project/pulls/1', controller.signal), /GitHub request failed/);
  const cancelled = new AbortController();
  const waiting = ra('repos/example/project/pulls/2', cancelled.signal);
  const rejected = assert.rejects(waiting, /cancelled queued request/);
  cancelled.abort(new Error('cancelled queued request'));
  await rejected;
  assert.deepEqual(await rb('repos/example/project/pulls/1', AbortSignal.timeout(5000)), { account: 'b' });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(calls.map(x => x.account), [a, b]);
  assert.ok(calls.every(x => x.args.includes('GET') && x.args.includes('github.com')));
});

const target: BackgroundTarget = { room: '!room:example.com', sender: '@alice:example.com', key: 'conversation', session: 'session-1' };
const signal = () => new AbortController().signal;
const selection = { action: 'subscribe', repository: 'example/project', pull_requests: [1], events: ['checks', 'reviews', 'comments', 'pull_request'] };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'github-subscriptions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  const path = join(root, 'subscriptions.json'), inbox = join(root, 'background.json');
  const policy = { ghConfigDir: root, repositories: ['example/project'] };
  const state = {
    pr: { head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, state: 'open', merged: false, draft: false },
    comments: [{ id: 1, updated_at: '2026-01-01T00:00:00Z', body: 'Untrusted comment text' }],
    reviews: [{ id: 2, state: 'APPROVED', commit_id: 'a'.repeat(40), submitted_at: '2026-01-01T00:00:00Z' }],
    checks: [{ id: 3, name: 'test', status: 'in_progress', conclusion: null as string | null, completed_at: null as string | null }],
  };
  const requests: string[] = [];
  const read: GitHubRead = async (endpoint, s) => {
    s.throwIfAborted(); requests.push(endpoint);
    if (/\/pulls\/1$/.test(endpoint)) return structuredClone(state.pr);
    if (endpoint.includes('/check-runs?')) return { check_runs: structuredClone(state.checks) };
    if (endpoint.includes('/statuses?')) return [];
    if (endpoint.includes('/reviews?')) return structuredClone(state.reviews);
    if (endpoint.includes('/issues/1/comments?')) return structuredClone(state.comments);
    if (endpoint.includes('/pulls/1/comments?')) return [];
    throw new Error('Unexpected endpoint: ' + endpoint);
  };
  const queue = new BackgroundTasks(inbox, root);
  const subscriptions = new GitHubSubscriptions(path, policy, queue, read);
  const stored = () => JSON.parse(readFileSync(path, 'utf8')).subscriptions[0];
  const notices = (q = queue) => JSON.parse(q.action({ action: 'list' }, target, signal()));
  return { root, path, inbox, policy, state, requests, read, queue, subscriptions, stored, notices };
}

test('baseline, duplicate registration and unchanged restart do not replay existing events', async t => {
  const f = fixture(t);
  const first = JSON.parse(await f.subscriptions.action(selection, target, signal()));
  const duplicate = JSON.parse(await f.subscriptions.action(selection, target, signal()));
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.already_subscribed, true);
  t.mock.timers.tick(61_000);
  await new GitHubSubscriptions(f.path, f.policy, f.queue, f.read).pump(() => true, signal());
  assert.equal(f.notices().length, 0);
  assert.equal(f.stored().failures, 0);
});

test('completed checks, edited comments, review dismissal and merged state form one bounded notice', async t => {
  const f = fixture(t);
  await f.subscriptions.action(selection, target, signal());
  f.state.checks[0] = { ...f.state.checks[0], status: 'completed', conclusion: 'failure', completed_at: '2026-01-01T00:01:00Z' };
  f.state.comments[0].updated_at = '2026-01-01T00:01:00Z';
  f.state.reviews[0].state = 'DISMISSED'; f.state.pr.state = 'closed'; f.state.pr.merged = true;
  t.mock.timers.tick(61_000);
  await f.subscriptions.pump(() => true, signal());
  const notices = f.notices(); assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0].message, /Untrusted comment text/);
  const info = JSON.parse(notices[0].message.split('\n').at(-1));
  assert.equal(info.count, 4);
  assert.deepEqual(info.changes.map((e: any) => e.event).sort(), ['checks', 'comments', 'pull_request', 'reviews']);
  assert.ok(info.changes.every((e: any) => e.sha === f.state.pr.head.sha));
});

test('partial pagination and a changing head leave the previous snapshot intact', async t => {
  const f = fixture(t);
  await f.subscriptions.action(selection, target, signal());
  const before = f.stored().snapshot;
  let fail = true;
  const read: GitHubRead = async (endpoint, s) => {
    if (endpoint.includes('/issues/1/comments?')) {
      if (endpoint.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => ({ id: i + 1, updated_at: '2026-01-01T00:02:00Z' }));
      if (fail) throw new Error('Second page failed');
      return [];
    }
    return f.read(endpoint, s);
  };
  const subscriptions = new GitHubSubscriptions(f.path, f.policy, f.queue, read);
  t.mock.timers.tick(61_000); await subscriptions.pump(() => true, signal());
  assert.deepEqual(f.stored().snapshot, before); assert.equal(f.notices().length, 0);
  fail = false;
  t.mock.timers.tick(121_000); await subscriptions.pump(() => true, signal());
  assert.equal(f.notices().length, 1); assert.equal(f.stored().failures, 0);
  const after = f.stored().snapshot;
  let reads = 0;
  const racing = new GitHubSubscriptions(f.path, f.policy, f.queue, async (endpoint, s) => {
    const result = await read(endpoint, s);
    if (/\/pulls\/1$/.test(endpoint) && ++reads === 2) result.head.sha = 'b'.repeat(40);
    return result;
  });
  t.mock.timers.tick(61_000); await racing.pump(() => true, signal());
  assert.deepEqual(f.stored().snapshot, after); assert.equal(f.notices().length, 1);
  assert.equal(f.stored().failures, 1);
});

test('an outbox survives a full inbox and restart without losing or duplicating its notification', async t => {
  const f = fixture(t);
  await f.subscriptions.action(selection, target, signal());
  for (let i = 0; i < 100; i++) f.queue.notify('other-' + i, target, 'Other task', { group: 'other-' + i, progress: false });
  f.state.pr.draft = true;
  t.mock.timers.tick(61_000); await f.subscriptions.pump(() => true, signal());
  const pending = f.stored().pending; assert.ok(pending);
  f.queue.action({ action: 'cancel', id: 'other-0' }, target, signal());
  const queue = new BackgroundTasks(f.inbox, f.root);
  const subscriptions = new GitHubSubscriptions(f.path, f.policy, queue, async () => { throw new Error('Must deliver pending outbox before polling'); });
  t.mock.timers.tick(121_000); await subscriptions.pump(() => true, signal());
  assert.equal(f.stored().pending, undefined);
  assert.equal(f.notices(queue).filter((n: any) => n.id === pending.id).length, 1);
  // Simulate a crash after inbox persistence but before clearing the outbox.
  const persisted = JSON.parse(readFileSync(f.path, 'utf8'));
  persisted.subscriptions[0].pending = pending;
  writeFileSync(f.path, JSON.stringify(persisted));
  const restarted = new GitHubSubscriptions(f.path, f.policy, queue, f.read);
  await restarted.pump(() => true, signal());
  assert.equal(f.stored().pending, undefined);
  assert.equal(f.notices(queue).filter((n: any) => n.id === pending.id).length, 1);
});

test('subscriptions isolate conversations and revoke queued notices on cancellation or lost policy', async t => {
  const f = fixture(t);
  const first = JSON.parse(await f.subscriptions.action(selection, target, signal()));
  const other = { ...target, room: '!other:example.com' };
  assert.equal(JSON.parse(await f.subscriptions.action({ action: 'list' }, other, signal())).subscriptions.length, 0);
  await assert.rejects(f.subscriptions.action({ action: 'cancel', id: first.id }, other, signal()), /No such/);
  f.state.pr.draft = true; t.mock.timers.tick(61_000);
  await f.subscriptions.pump(() => true, signal()); assert.equal(f.notices().length, 1);
  await f.subscriptions.action({ action: 'cancel', id: first.id }, target, signal()); assert.equal(f.notices().length, 0);
  await f.subscriptions.action(selection, target, signal());
  f.state.pr.draft = false; t.mock.timers.tick(61_000);
  await f.subscriptions.pump(() => true, signal()); assert.equal(f.notices().length, 1);
  const revoked = new GitHubSubscriptions(f.path, undefined, f.queue);
  await revoked.pump(() => true, signal());
  assert.equal(f.notices().length, 0); assert.equal(f.stored().state, 'cancelled');
});
