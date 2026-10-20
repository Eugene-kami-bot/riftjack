import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePublish, pushReviewed, requestPublish, publishInput } from '../src/publish.js';

function setup(t: { after(fn: () => void): void }, existing = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'publish-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('init', '--bare', remote);
  writeFileSync(join(repo, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'Initial');
  git('remote', 'add', 'origin', remote);
  if (existing) git('push', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'file.txt'), 'base\n<script>alert("test")</script>\n'); git('add', '.'); git('commit', '-m', 'Update <script>');
  const head = git('rev-parse', 'HEAD');
  const input = { repository: repo, remote: 'origin', branch: 'main' };
  const prepare = () => preparePublish(input, root, new AbortController().signal);
  const remoteHead = () => git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0] || null;
  return { root, repo, remote, git, base, head, input, prepare, remoteHead };
}
const signal = () => new AbortController().signal;

test('review uses committed outgoing history and escapes HTML with numbered diff lines', async t => {
  const f = setup(t);
  writeFileSync(join(f.repo, 'file.txt'), 'uncommitted-private-text');
  writeFileSync(join(f.repo, 'untracked.txt'), 'untracked-private-text');
  const r = await f.prepare();
  assert.equal(r.base, f.base); assert.equal(r.head, f.head);
  assert.deepEqual(r.commits, [f.head]); assert.equal(r.workingTreeDirty, true);
  assert.match(r.html, /&lt;script&gt;/); assert.doesNotMatch(r.html, /<script>|uncommitted-private-text|untracked-private-text/);
  assert.match(r.html, /Content-Security-Policy/); assert.match(r.html, /class="line add"/);
  assert.match(r.html, /class="number">2</);
  assert.equal(f.remoteHead(), f.base);
  assert.ok(Object.isFrozen(r));
});

test('review includes reverted intermediate changes, renames, deletions and binary markers', async t => {
  const f = setup(t);
  writeFileSync(join(f.repo, 'temporary.txt'), 'intermediate-change');
  f.git('add', '.'); f.git('commit', '-m', 'Add temporary file');
  rmSync(join(f.repo, 'temporary.txt')); renameSync(join(f.repo, 'file.txt'), join(f.repo, 'renamed.txt'));
  writeFileSync(join(f.repo, 'binary.dat'), Buffer.from([0, 1, 2, 0, 4]));
  f.git('add', '-A'); f.git('commit', '-m', 'Rename, delete and add binary');
  const r = await f.prepare();
  assert.match(r.html, /rename from file.txt/); assert.match(r.patch, /Binary files/);
  assert.doesNotMatch(r.patch, /intermediate-change/);
  assert.match(r.html, /intermediate-change/); assert.match(r.html, /deleted file mode/);
  assert.equal(r.commits.length, 3);
});

test('new branch report covers the complete tree and history', async t => {
  const f = setup(t, false), r = await f.prepare();
  assert.equal(r.base, null); assert.equal(r.commits.length, 2);
  assert.match(r.patch, /new file mode/); assert.match(r.patch, /\+base/);
  await pushReviewed(r, signal()); assert.equal(f.remoteHead(), f.head);
});

test('new branch excludes a long published history and ignores local tracking refs', async t => {
  const f = setup(t);
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  let parent = f.head;
  for (let i = 0; i < 101; i++) parent = f.git('commit-tree', tree, '-p', parent, '-m', 'Published ' + i);
  f.git('update-ref', 'refs/heads/main', parent);
  f.git('push', 'origin', 'main');
  f.git('--git-dir=' + f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  f.git('commit', '--allow-empty', '-m', 'Only new change');
  const head = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/remotes/origin/main', head);
  const r = await preparePublish({ ...f.input, branch: 'feature' }, f.root, signal());
  assert.equal(r.base, null); assert.equal(r.reviewBase, parent);
  assert.deepEqual(r.baseReference, { ref: 'refs/heads/main', head: parent });
  assert.deepEqual(r.commits, [head]); assert.equal(r.patch, '');
  assert.match(r.html, new RegExp(parent));
  await pushReviewed(r, signal());
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/feature').split('\t')[0], head);
});

test('new branch uses the common ancestor when the published default branch diverged', async t => {
  const f = setup(t);
  f.git('--git-dir=' + f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  f.git('checkout', '-b', 'other', f.base);
  writeFileSync(join(f.repo, 'remote-only.txt'), 'Only remote');
  f.git('add', '.'); f.git('commit', '-m', 'Remote diverges');
  const remoteTip = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'HEAD:main'); f.git('checkout', 'main');
  const r = await preparePublish({ ...f.input, branch: 'feature' }, f.root, signal());
  assert.equal(r.reviewBase, f.base); assert.equal(r.baseReference?.head, remoteTip);
  assert.deepEqual(r.commits, [f.head]); assert.doesNotMatch(r.patch, /remote-only/);
  await pushReviewed(r, signal());
  assert.equal(f.remoteHead(), remoteTip);
});

for (const change of ['published-base', 'new-destination'] as const) test(`new-branch review rejects changed ${change}`, async t => {
  const f = setup(t);
  f.git('--git-dir=' + f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const r = await preparePublish({ ...f.input, branch: 'feature' }, f.root, signal());
  f.git('push', 'origin', change === 'published-base' ? 'HEAD:main' : 'HEAD:feature');
  await assert.rejects(pushReviewed(r, signal()), /changed after review/);
});

test('creating a branch at an already published tip still requires approval', async t => {
  const f = setup(t);
  f.git('push', 'origin', 'HEAD:main');
  f.git('--git-dir=' + f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  let requested = false;
  const result = await requestPublish({ ...f.input, branch: 'feature' }, f.root, f.root, 1024 ** 2, signal(), async request => {
    requested = true;
    assert.match(request.text, /Published base reference/);
    return request.deny;
  }, async () => {});
  assert.ok(requested); assert.match(result, /declined/);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/feature'), '');
});

test('reviewed push sends only the approved commit and no unrelated tags', async t => {
  const f = setup(t), r = await f.prepare();
  f.git('tag', '-a', 'unrelated', '-m', 'Tag'); f.git('config', 'push.followTags', 'true');
  await pushReviewed(r, signal()); assert.equal(f.remoteHead(), f.head);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/unrelated'), '');
  await assert.rejects(f.prepare(), /nothing to publish/);
});

for (const change of ['head', 'remote', 'destination'] as const) test(`publication refuses changed ${change}`, async t => {
  const f = setup(t), r = await f.prepare();
  if (change === 'head') f.git('commit', '--allow-empty', '-m', 'Later');
  if (change === 'remote') { const other = join(f.root, 'other.git'); f.git('init', '--bare', other); f.git('remote', 'set-url', '--push', 'origin', other); }
  if (change === 'destination') f.git('push', 'origin', 'HEAD:main');
  await assert.rejects(pushReviewed(r, signal()), /changed after review/);
});

test('remote race after revalidation is rejected by the explicit lease', async t => {
  const f = setup(t), r = await f.prepare();
  await assert.rejects(pushReviewed(r, signal(), async () => { f.git('commit', '--allow-empty', '-m', 'Concurrent publication'); f.git('push', 'origin', 'HEAD:main'); }), /not confirmed/);
  assert.equal(f.remoteHead(), f.git('rev-parse', 'HEAD'));
  assert.notEqual(f.remoteHead(), f.head);
});

test('outside workspaces and unsupported remotes are rejected', async t => {
  const f = setup(t);
  await assert.rejects(preparePublish(f.input, join(f.root, 'remote.git'), signal()), /workspace/);
  f.git('remote', 'set-url', '--push', 'origin', 'ext::echo unsafe');
  await assert.rejects(f.prepare(), /HTTPS, SSH/);
  f.git('remote', 'set-url', '--push', 'origin', 'https://user:password@example.com/repo');
  await assert.rejects(f.prepare(), /credential-free/);
  f.git('remote', 'set-url', '--push', 'origin', f.remote);
  assert.throws(() => publishInput({ ...f.input, remote: '--help' }), /Supply/);
  assert.throws(() => publishInput({ ...f.input, force: true }), /Supply/);
});

for (const approved of [false, true]) test(`report attachment precedes ${approved ? 'approval' : 'denial'} and is cleaned up`, async t => {
  const f = setup(t); let path = '';
  const result = await requestPublish(f.input, f.root, f.root, 1024 ** 2, signal(), async request => {
    path = request.attachments![0].path;
    const html = readFileSync(path, 'utf8'); assert.match(html, /Publication review/);
    assert.match(request.text, new RegExp(f.head)); assert.equal(f.remoteHead(), f.base);
    return approved ? request.approve! : request.deny;
  }, async () => {});
  assert.equal(existsSync(path), false);
  assert.equal(f.remoteHead(), approved ? f.head : f.base);
  assert.match(result, approved ? /Published/ : /declined/);
});

test('cancellation, access revocation, attachment failure and size limit never publish', async t => {
  const f = setup(t);
  await assert.rejects(requestPublish(f.input, f.root, f.root, 1, signal(), async () => assert.fail('No approval'), async () => {}), /attachment limit/);
  await assert.rejects(requestPublish(f.input, f.root, f.root, 1024 ** 2, signal(), async () => { throw new Error('Delivery failed'); }, async () => {}), /Delivery failed/);
  await assert.rejects(requestPublish(f.input, f.root, f.root, 1024 ** 2, signal(), async r => r.approve!, async () => { throw new Error('Revoked'); }), /Revoked/);
  const controller = new AbortController();
  await assert.rejects(requestPublish(f.input, f.root, f.root, 1024 ** 2, controller.signal, async r => { controller.abort(); return r.approve!; }, async () => {}));
  assert.equal(f.remoteHead(), f.base);
});

test('report-only CLI emits structured metadata, never pushes and refuses overwriting its output', t => {
  const f = setup(t), output = join(f.root, 'review.html');
  const args = ['--import', 'tsx', 'scripts/prepare-publish.mts', '--workspace', f.root, '--request', JSON.stringify(f.input), '--output', output];
  const metadata = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(metadata.head, f.head); assert.equal(metadata.published, false);
  assert.equal(metadata.output, output); assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.match(readFileSync(output, 'utf8'), /Publication review/);
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  assert.equal(f.remoteHead(), f.base);
});

function rewritten(t: { after(fn: () => void): void }) {
  const f = setup(t);
  f.git('push', 'origin', 'HEAD:main');
  f.git('commit', '--amend', '-m', 'Rewritten update');
  return f;
}

for (const approved of [false, true]) test(`history replacement ${approved ? 'approval' : 'denial'} reviews both histories before pushing`, async t => {
  const f = rewritten(t), head = f.git('rev-parse', 'HEAD');
  const r = await f.prepare();
  assert.equal(r.historyReplacement, true); assert.equal(r.base, f.head);
  assert.equal(r.patch, ''); assert.deepEqual(r.commits, [head]);
  assert.deepEqual(r.removedHistory.map(c => c.oid), [f.head]);
  assert.match(r.html, /History replacement/); assert.match(r.html, /Removed history/);
  assert.match(r.html, /Update &lt;script&gt;/); assert.doesNotMatch(r.html, /<script>/);
  assert.ok(Object.isFrozen(r.removedHistory));
  const result = await requestPublish(f.input, f.root, f.root, 1024 ** 2, signal(), async request => {
    assert.match(request.text, /HISTORY REPLACEMENT/); assert.match(request.text, /Removed commits/);
    assert.match(readFileSync(request.attachments![0].path, 'utf8'), new RegExp(f.head));
    assert.equal(f.remoteHead(), f.head);
    return approved ? request.approve! : request.deny;
  }, async () => {});
  assert.equal(f.remoteHead(), approved ? head : f.head);
  assert.match(result, approved ? /Published/ : /declined/);
});

for (const race of ['before-validation', 'after-validation'] as const) test(`history replacement preserves concurrent updates ${race}`, async t => {
  const f = rewritten(t), r = await f.prepare();
  const concurrent = f.git('commit-tree', f.git('rev-parse', f.head + '^{tree}'), '-p', f.head, '-m', 'Concurrent work');
  const advance = () => { f.git('push', 'origin', concurrent + ':main'); };
  if (race === 'before-validation') advance();
  await assert.rejects(pushReviewed(r, signal(), async () => { if (race === 'after-validation') advance(); }),
    race === 'before-validation' ? /changed after review/ : /not confirmed/);
  assert.equal(f.remoteHead(), concurrent);
});

test('rebase shows fresh base commits and old reverted history', async t => {
  const f = setup(t);
  writeFileSync(join(f.repo, 'temporary.txt'), 'Old history only');
  f.git('add', '.'); f.git('commit', '-m', 'Intermediate');
  rmSync(join(f.repo, 'temporary.txt')); f.git('add', '-A'); f.git('commit', '-m', 'Revert');
  f.git('push', 'origin', 'HEAD:main');
  const oldHead = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-b', 'upstream', f.base);
  writeFileSync(join(f.repo, 'new-base.txt'), 'Upstream change');
  f.git('add', '.'); f.git('commit', '-m', 'Fresh base');
  const upstream = f.git('rev-parse', 'HEAD'); f.git('cherry-pick', f.head);
  const r = await f.prepare();
  assert.equal(r.base, oldHead); assert.equal(r.historyReplacement, true);
  assert.equal(r.commits.length, 2); assert.ok(r.commits.includes(upstream));
  assert.equal(r.removedHistory.length, 3); assert.match(r.html, /Old history only/);
  assert.match(r.patch, /Upstream change/); assert.doesNotMatch(r.patch, /Old history only/);
});

test('rollback lists removed commits even without outgoing commits', async t => {
  const f = setup(t); f.git('push', 'origin', 'HEAD:main'); f.git('reset', '--hard', f.base);
  const r = await f.prepare();
  assert.equal(r.historyReplacement, true); assert.equal(r.commits.length, 0);
  assert.deepEqual(r.removedHistory.map(c => c.oid), [f.head]); assert.match(r.patch, /-<script>/);
});

test('removed history counts towards the review limit', async t => {
  const f = setup(t); let parent = f.head;
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  for (let i = 0; i < 101; i++) parent = f.git('commit-tree', tree, '-p', parent, '-m', 'Old ' + i);
  f.git('push', 'origin', parent + ':main');
  await assert.rejects(f.prepare(), /100 outgoing and removed/);
});

test('unrelated history is rejected without changing the destination', async t => {
  const f = setup(t);
  const unrelated = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-m', 'Unrelated root');
  f.git('checkout', '--detach', unrelated);
  await assert.rejects(f.prepare()); assert.equal(f.remoteHead(), f.base);
});
