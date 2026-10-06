import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fetchAction, isPublicAddress, loadFetchConfig, parsePrefix, publicLookup, type FetchResponse, type Transport } from '../src/fetch.js';

const signal = new AbortController().signal;
const API = 'https://api.github.com/repos/ydb-platform/ydb/';

function setup(t: { after(fn: () => void): void }, extra: NodeJS.ProcessEnv = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fetch-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'token'), 'secret-token\n');
  const config = loadFetchConfig({
    FETCH_ALLOW: `${API} https://*.blob.core.windows.net/`,
    FETCH_AUTH: `${API}actions/|${join(dir, 'token')}`, ...extra,
  })!;
  return { dir, config };
}

function body(chunks: (string | Error)[], destroyed = { value: false }): FetchResponse['body'] {
  return Object.assign((async function* () {
    for (const c of chunks) { if (c instanceof Error) throw c; yield Buffer.from(c); }
  })(), { destroy() { destroyed.value = true; } });
}
const ok = (text: string, contentType = 'text/plain'): FetchResponse => ({ status: 200, contentType, body: body([text]) });
const redirect = (location: string): FetchResponse => ({ status: 302, location, contentType: '', body: body([]) });

type Call = { url: string; headers: Record<string, string> };
function fake(responses: Record<string, () => FetchResponse>) {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url: url.toString(), headers: init.headers });
    const make = responses[url.toString()];
    if (!make) throw new Error('unexpected url ' + url);
    return make();
  };
  return { calls, transport };
}
const files = (dir: string) => { try { return readdirSync(join(dir, '.fetch')); } catch { return []; } };

test('fetch prefixes must be HTTPS and end with a slash; auth must stay inside allow and without wildcards', () => {
  for (const bad of ['http://a.test/', 'https://a.test/x', 'https://u:p@a.test/', 'https://a.test/?q=1/', 'not a url']) assert.throws(() => parsePrefix(bad));
  assert.equal(loadFetchConfig({}), undefined);
  const dir = mkdtempSync(join(tmpdir(), 'fetch-cfg-'));
  try {
    writeFileSync(join(dir, 't'), 'x');
    assert.throws(() => loadFetchConfig({ FETCH_ALLOW: 'https://a.test/r/', FETCH_AUTH: `https://b.test/|${join(dir, 't')}` }), /inside FETCH_ALLOW/);
    assert.throws(() => loadFetchConfig({ FETCH_ALLOW: 'https://*.a.test/', FETCH_AUTH: `https://*.a.test/|${join(dir, 't')}` }), /wildcard/);
    assert.ok(loadFetchConfig({ FETCH_ALLOW: 'https://a.test/r/', FETCH_AUTH: `https://a.test/r/x/|${join(dir, 't')}` }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fetch refuses URLs outside the prefixes, sibling paths, encoded traversal, other methods and extra arguments', async t => {
  const { dir, config } = setup(t);
  const { calls, transport } = fake({});
  const action = fetchAction(config, dir, transport);
  for (const input of [
    { url: 'https://api.github.com/repos/ydb-platform/ydb-evil/pulls' },
    { url: 'https://api.github.com/user' },
    { url: `${API}%2e%2e/other` }, { url: `${API}a%2fb` }, { url: `${API}a%5cb` },
    { url: 'http://api.github.com/repos/ydb-platform/ydb/pulls' },
    { url: 'https://api.github.com:8443/repos/ydb-platform/ydb/pulls' },
    { url: 'https://blob.core.windows.net/x' },
    { url: 'https://evil.test/?u=https://api.github.com/repos/ydb-platform/ydb/' },
    { url: `${API}pulls`, method: 'POST' }, { url: `${API}pulls`, body: 'x' }, { url: `${API}pulls`, headers: {} },
    null, [], {},
  ]) await assert.rejects(action(input, signal));
  assert.equal(calls.length, 0);
});

test('non-public addresses are refused, including mapped IPv6 and IP literals', async t => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['8.8.8.8', '140.82.112.6', '2606:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  const { dir } = setup(t);
  const config = loadFetchConfig({ FETCH_ALLOW: 'https://127.0.0.1/ https://[::1]/' })!;
  const { calls, transport } = fake({});
  const action = fetchAction(config, dir, transport);
  await assert.rejects(action({ url: 'https://127.0.0.1/x' }, signal), /non-public/);
  await assert.rejects(action({ url: 'https://[::1]/x' }, signal), /non-public/);
  assert.equal(calls.length, 0);
  // The connection's own lookup rejects names that resolve to loopback.
  const error = await new Promise<Error | null>(resolve => publicLookup('localhost', {}, e => resolve(e)));
  assert.equal((error as { code?: string })?.code, 'ERR_RIFTJACK_NON_PUBLIC');
});

test('fetch saves the body to a new file and attaches credentials only under their prefix', async t => {
  const { dir, config } = setup(t);
  const { calls, transport } = fake({
    [`${API}actions/runs/1`]: () => ok('{"ok":true}', 'application/json'),
    [`${API}pulls/1`]: () => ok('{"pr":1}', 'application/json'),
  });
  const action = fetchAction(config, dir, transport);
  const result = JSON.parse(await action({ url: `${API}actions/runs/1` }, signal));
  assert.equal(result.status, 200);
  assert.equal(result.text, undefined);
  assert.equal(readFileSync(result.file, 'utf8'), '{"ok":true}');
  assert.ok(result.file.startsWith(join(dir, '.fetch') + '/'));
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  // Same host, outside the token's prefix: no credentials.
  await action({ url: `${API}pulls/1` }, signal);
  assert.equal(calls[1].headers.Authorization, undefined);
});

test('fetch re-selects credentials on every redirect hop, including on the same host', async t => {
  const { dir, config } = setup(t);
  const { calls, transport } = fake({
    [`${API}actions/jobs/7/logs`]: () => redirect('https://store.blob.core.windows.net/logs/7'),
    'https://store.blob.core.windows.net/logs/7': () => ok('log text'),
    [`${API}actions/jobs/8/logs`]: () => redirect(`${API}pulls/8`),
    [`${API}pulls/8`]: () => ok('pr'),
    [`${API}actions/away`]: () => redirect('https://evil.test/steal'),
  });
  const action = fetchAction(config, dir, transport);
  const result = JSON.parse(await action({ url: `${API}actions/jobs/7/logs` }, signal));
  assert.equal(result.url, 'https://store.blob.core.windows.net/logs/7');
  assert.equal(readFileSync(result.file, 'utf8'), 'log text');
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[1].headers.Authorization, undefined);
  await action({ url: `${API}actions/jobs/8/logs` }, signal);
  assert.equal(calls[2].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[3].headers.Authorization, undefined);
  await assert.rejects(action({ url: `${API}actions/away` }, signal), /not allowed/);
  assert.equal(calls.some(c => c.url.startsWith('https://evil.test')), false);
});

test('Python must be outside the workspace, and a refused save still closes the response and writes nothing outside', async t => {
  const { dir, config } = setup(t);
  assert.throws(() => loadFetchConfig({ FETCH_ALLOW: API, FETCH_PYTHON: join(dir, 'missing') }), /needs Python 3/);
  assert.throws(() => loadFetchConfig({ FETCH_ALLOW: API, FETCH_PYTHON: config.python }, dirname(config.python)), /outside RIFTJACK_WORKSPACE/);
  const outside = join(dir, 'outside'), workspace = join(dir, 'ws');
  mkdirSync(outside); mkdirSync(workspace);
  const destroyed = { value: false };
  const { transport } = fake({ [`${API}pulls/1`]: () => ({ status: 200, contentType: 'text/plain', body: body(['data'], destroyed) }) });
  const action = fetchAction(config, workspace, transport);
  // .fetch swapped for a symlink to a directory outside the workspace.
  symlinkSync(outside, join(workspace, '.fetch'));
  await assert.rejects(action({ url: `${API}pulls/1` }, signal), /Saving the response failed/);
  assert.equal(destroyed.value, true);
  assert.deepEqual(readdirSync(outside), []);
  // A symlink anywhere in the workspace path itself.
  rmSync(join(workspace, '.fetch'));
  symlinkSync(workspace, join(dir, 'link'));
  await assert.rejects(fetchAction(config, join(dir, 'link'), transport)({ url: `${API}pulls/1` }, signal), /Saving the response failed/);
  assert.deepEqual(readdirSync(workspace), []);
});

// Drives the helper directly: the swap happens after it opened the directory and the file.
test('the save helper keeps writing into the directory it opened and removes uncommitted files there', async t => {
  const { dir, config } = setup(t);
  const helper = join(import.meta.dirname, '..', 'scripts', 'fetch-save.py');
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  const frame = (data: string) => { const b = Buffer.from(data), h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  async function run(name: string, frames: Buffer[], afterReady = () => {}) {
    const child = spawn(config.python, [helper, dir, name, '100']);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const code = new Promise<number | null>(resolve => child.once('close', resolve));
    await new Promise<void>(resolve => { const check = () => out.includes('ready') || child.exitCode !== null ? resolve() : setTimeout(check, 5); check(); });
    if (out.includes('ready')) afterReady();
    for (const f of frames) child.stdin.write(f);
    child.stdin.end();
    return { code: await code, out };
  }
  const commit = Buffer.alloc(4);
  const swap = () => { renameSync(join(dir, '.fetch'), join(dir, 'moved')); symlinkSync(outside, join(dir, '.fetch')); };
  assert.equal((await run('1-a.txt', [frame('first')])).code, 1); // stdin ends before the commit
  assert.deepEqual(files(dir), []);
  assert.equal((await run('2-a.txt', [frame('kept')], swap)).code, 1);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(readdirSync(join(dir, 'moved')), []);
  rmSync(join(dir, '.fetch'));
  renameSync(join(dir, 'moved'), join(dir, '.fetch'));
  const saved = await run('3-a.txt', [frame('one '), frame('two'), commit], swap);
  assert.equal(saved.code, 0);
  assert.match(saved.out, /saved 7/);
  assert.equal(readFileSync(join(dir, 'moved', '3-a.txt'), 'utf8'), 'one two');
  assert.deepEqual(readdirSync(outside), []);
  rmSync(join(dir, '.fetch'));
  renameSync(join(dir, 'moved'), join(dir, '.fetch'));
  // An existing name is refused, not overwritten; too much data and bad names are refused too.
  assert.equal((await run('3-a.txt', [frame('x'), commit])).code, 1);
  assert.equal(readFileSync(join(dir, '.fetch', '3-a.txt'), 'utf8'), 'one two');
  assert.equal((await run('4-a.txt', [frame('x'.repeat(101)), commit])).code, 1);
  assert.equal((await run('../5-a.txt', [commit])).code, 1);
  assert.deepEqual(files(dir), ['3-a.txt']);
});

test('fetch truncates at the limit, removes partial files on failure or cancel, and HEAD writes nothing', async t => {
  const { dir, config } = setup(t, { FETCH_MAX_BYTES: '65536' });
  const destroyed = { value: false };
  const controller = new AbortController();
  const { transport } = fake({
    [`${API}big`]: () => ({ status: 200, contentType: 'text/plain', body: body(['x'.repeat(40_000), 'y'.repeat(40_000)], destroyed) }),
    [`${API}broken`]: () => ({ status: 200, contentType: 'text/plain', body: body(['partial', new Error('reset')]) }),
    [`${API}slow`]: () => ({ status: 200, contentType: 'text/plain', body: Object.assign((async function* () {
      yield Buffer.from('first'); controller.abort(); yield Buffer.from('second');
    })(), { destroy() {} }) }),
  });
  const action = fetchAction(config, dir, transport);
  const result = JSON.parse(await action({ url: `${API}big` }, signal));
  assert.equal(result.truncated, true);
  assert.equal(result.bytes, 65536);
  assert.equal(readFileSync(result.file, 'utf8').length, 65536);
  assert.equal(destroyed.value, true);
  const before = files(dir).length;
  await assert.rejects(action({ url: `${API}broken` }, signal), /Saving the response failed/);
  await assert.rejects(action({ url: `${API}slow` }, controller.signal));
  assert.equal(files(dir).length, before);
  const head = JSON.parse(await action({ url: `${API}big`, method: 'HEAD' }, signal));
  assert.equal(head.file, undefined);
  assert.equal(files(dir).length, before);
});

// A helper that is slow to start or never starts must not hang the tool or crash the connector.
test('a stream error while the helper starts is reported, and cancel ends a hung helper quickly', async t => {
  const { dir, config } = setup(t);
  const wrapper = (name: string, body: string) => { const file = join(dir, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700); return file; };
  const slow = { ...config, python: wrapper('slow.sh', `sleep 0.5\nexec "${config.python}" "$@"`) };
  const stream = new PassThrough();
  const { transport } = fake({ [`${API}reset`]: () => {
    setTimeout(() => stream.destroy(new Error('connection reset')), 50);
    return { status: 200, contentType: 'text/plain', body: stream };
  } });
  await assert.rejects(fetchAction(slow, dir, transport)({ url: `${API}reset` }, signal), /Saving the response failed/);
  assert.deepEqual(files(dir), []);

  const hung = { ...config, python: wrapper('hung.sh', 'exec sleep 30') };
  const controller = new AbortController();
  const { transport: second } = fake({ [`${API}hang`]: () => ok('data') });
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await assert.rejects(fetchAction(hung, dir, second)({ url: `${API}hang` }, controller.signal));
  assert.ok(Date.now() - started < 2_000, `cancel took ${Date.now() - started} ms`);
});
