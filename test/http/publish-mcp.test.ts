import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { startPublishMcp, type PublishConnection } from '../../src/publish-mcp.js';
import { requestPublish } from '../../src/publish.js';
import { Bridge, type MatrixEvent } from '../../src/bridge.js';
import { createBackend } from '../../src/backends.js';
import { State } from '../../src/state.js';
import { loadConfig } from '../../src/config.js';

const input = { repository: '.', remote: 'origin', branch: 'main' };
const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
}
function post(connection: PublishConnection, method: string, id?: number, params?: object, extra?: RequestInit) {
  return fetch(connection.url, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(id !== undefined && { id }), params }), ...extra });
}
const call = (connection: PublishConnection, id = 3, args: object = input) => post(connection, 'tools/call', id, { name: 'prepare_publish', arguments: args });

// These tests open loopback listeners. They deliberately stay out of npm test.
test('publication MCP advertises the tool, validates requests, and prevents replay', async t => {
  let calls = 0;
  const server = await startPublishMcp(async value => { calls++; assert.deepEqual(value, input); return 'Published.'; }, signal());
  t.after(() => server.close());
  const init = await (await post(server, 'initialize', 1, { protocolVersion: '2025-06-18' })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal((await post(server, 'notifications/initialized')).status, 202);
  const list = await (await post(server, 'tools/list', 2)).json();
  assert.equal(list.result.tools[0].name, 'prepare_publish');
  assert.equal(list.result.tools[0].annotations.destructiveHint, true);
  assert.equal(list.result.tools[0].inputSchema.additionalProperties, false);
  assert.equal((await (await call(server, 3, { ...input, approve: true })).json()).result.isError, true);
  assert.equal(calls, 0);
  assert.equal((await (await call(server, 4)).json()).result.content[0].text, 'Published.');
  assert.ok((await (await call(server, 4)).json()).error);
  assert.equal(calls, 1);
  assert.equal((await post(server, 'anything', 5)).status, 200);
  assert.equal((await (await post(server, 'anything', 6)).json()).error.code, -32601);
});

test('publication MCP requires its task credential and rejects browser, oversized and foreign requests', async t => {
  let calls = 0;
  const server = await startPublishMcp(async () => { calls++; return 'unexpected'; }, signal());
  t.after(() => server.close());
  assert.equal((await call({ ...server, headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await post(server, 'tools/list', 1, {}, { headers: { ...server.headers, 'Content-Type': 'application/json', Origin: 'https://example.com' } })).status, 403);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.url, { method: 'POST', headers: { ...server.headers, Host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await call({ ...server, url: server.url + '/other' })).status, 404);
  assert.equal((await fetch(server.url, { headers: server.headers })).status, 405);
  assert.equal((await post(server, 'tools/list', 1, {}, { body: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await (await post(server, 'tools/list', 1, {}, { body: '{' })).json()).error.code, -32700);
  assert.equal(calls, 0);
});

for (const reason of ['notification', 'disconnect', 'task', 'close'] as const) test(`publication MCP cancels a pending review on ${reason}`, async t => {
  const started = deferred(), cancelled = deferred(), controller = new AbortController();
  const server = await startPublishMcp(async (_input, signal) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason); }, { once: true }));
    return 'unexpected';
  }, controller.signal);
  t.after(() => server.close());
  const requestController = new AbortController();
  const pending = post(server, 'tools/call', 10, { name: 'prepare_publish', arguments: input }, { signal: requestController.signal }).then(r => r.json()).catch(() => undefined);
  await started.promise;
  assert.ok((await (await call(server, 11)).json()).error);
  if (reason === 'notification') await post(server, 'notifications/cancelled', undefined, { requestId: 10 });
  if (reason === 'disconnect') requestController.abort();
  if (reason === 'task') controller.abort();
  if (reason === 'close') await server.close();
  await cancelled.promise;
  const result = await pending;
  if (reason === 'notification') assert.match(result.result.content[0].text, /cancelled/);
});

function fixture(t: { after(fn: () => void): void }, rewrite = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'riftjack-publish-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('init', '--bare', remote);
  writeFileSync(join(repo, 'demo.txt'), 'before\n'); git('add', '.'); git('commit', '-m', 'Initial');
  git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  let base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'demo.txt'), 'after\n'); git('add', '.'); git('commit', '-m', 'Update');
  if (rewrite) {
    git('push', 'origin', 'HEAD:main'); base = git('rev-parse', 'HEAD');
    git('commit', '--amend', '-m', 'Rebased update');
  }
  return { root, repo, base, head: git('rev-parse', 'HEAD'), remoteHead: () => git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0] };
}

// Real backend adapters with tiny CLI doubles: exercise MCP discovery/call over HTTP,
// Matrix attachment/confirmation delivery and a real push to an isolated bare repo.
for (const kind of ['codex', 'claude'] as const) for (const sender of ['@owner:test', '@guest:test']) for (const rewrite of [false, true]) test(`${kind} (${sender}, rewrite=${rewrite}) invokes reviewed publication through MCP and a resumed turn gets a fresh endpoint`, { timeout: 15_000 }, async t => {
  const f = fixture(t, rewrite), executable = join(f.root, 'engine.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
let connection;
async function invoke() {
  fs.appendFileSync(__filename + '.connections', JSON.stringify(connection) + '\\n');
  async function request(method, id, params) {
    const r = await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return (await r.json()).result;
  }
  await request('initialize', 1, { protocolVersion: '2025-03-26' });
  const list = await request('tools/list', 2);
  if (list.tools[0].name !== 'prepare_publish') throw Error('Missing tool');
  const result = await request('tools/call', 3, { name: 'prepare_publish', arguments: { repository: 'repo', remote: 'origin', branch: 'main' } });
  return result.content[0].text;
}
if (args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume --mcp-config'); process.exit(); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(); }
if (args.includes('--print')) {
  connection = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.riftjack_publish;
  if (!args[args.indexOf('--allowedTools') + 1].split(',').includes('mcp__riftjack_publish__prepare_publish') || connection.timeout !== 86400000) process.exit(2);
  readline.createInterface({ input: process.stdin }).once('line', async () => {
    const text = await invoke();
    send({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'session' });
  });
} else readline.createInterface({ input: process.stdin }).on('line', async line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (method === 'initialize') reply({});
  if (method === 'account/read') reply({ account: { type: 'chatgpt' } });
  if (method === 'thread/start' || method === 'thread/resume') {
    const c = params.config['mcp_servers.riftjack_publish'];
    // Codex otherwise asks an empty MCP consent form before entering the tool,
    // so no HTML can be generated or delivered. Only this reviewed tool is allowed.
    if (!c.required || c.tool_timeout_sec !== 86400 ||
        c.tools?.prepare_publish?.approval_mode !== 'approve' ||
        Object.keys(c.tools).length !== 1 || c.default_tools_approval_mode !== undefined) process.exit(2);
    connection = { url: c.url, headers: c.http_headers };
    reply({ thread: { id: 'thread' } });
  }
  if (method === 'thread/inject_items') reply({});
  if (method === 'turn/start') {
    reply({ turn: { id: 'turn', status: 'inProgress' } });
    const text = await invoke();
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text }] } } });
  }
});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.root, CODEX_PATH: executable, CLAUDE_PATH: executable });
  const state = new State(join(f.root, 'state.json')), backend = createBackend(config, state);
  const uploaded = deferred(), allowUpload = deferred(), confirmed = deferred();
  const messages: string[] = [];
  let deliveries = 0;
  const bridge = new Bridge({ botId: '@bot:test', kind, owner: config.owner, isAuthorized: () => true,
    isPrivateRoom: async () => true, since: 0, timeoutMs: 10_000, state, run: backend, steer: backend.steer,
    reply: async (_r, _e, text) => { messages.push(text); }, report: () => {},
    publish: (input, signal, interact, authorize) => requestPublish(input, f.root, f.root, 1024 * 1024, signal, interact, authorize),
    sendAttachments: async (_r, _e, files) => {
      deliveries++;
      assert.match(readFileSync(files[0].path, 'utf8'), new RegExp(f.head));
      assert.equal(f.remoteHead(), f.base);
      uploaded.resolve(); await allowUpload.promise;
    },
    confirmation: async (_r, _e, text, controls) => {
      if (rewrite) assert.match(text, /HISTORY REPLACEMENT/);
      else assert.doesNotMatch(text, /HISTORY REPLACEMENT/);
      assert.equal(deliveries, 1); controls.bind('$review'); confirmed.resolve(); },
  });
  t.after(() => bridge.stop());
  let nextId = 0;
  const event = (body: string): MatrixEvent => ({ event_id: '$' + ++nextId, sender, type: 'm.room.message', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body } });
  const task = bridge.handle('!room:test', event('Please publish the changes.'));
  await Promise.race([uploaded.promise, task.then(() => { throw new Error('Backend ended before delivering a review: ' + messages.at(-1)); })]);
  await bridge.handle('!room:test', event('!approve'));
  assert.match(messages.at(-1)!, /still being delivered/);
  await bridge.handle('!room:test', event('Publish a different branch instead.'));
  assert.match(messages.at(-1)!, /confirmation|cancel/);
  assert.equal(f.remoteHead(), f.base);
  allowUpload.resolve(); await confirmed.promise;
  await bridge.handle('!room:test', { ...event('!approve'), sender: sender === config.owner ? '@guest:test' : config.owner });
  assert.equal(f.remoteHead(), f.base);
  await bridge.handle('!room:test', event('!approve')); await task;
  assert.equal(f.remoteHead(), f.head);
  assert.match(messages.at(-1)!, /Published/);
  await bridge.handle('!room:test', event('Check publication again.'));
  assert.match(messages.at(-1)!, /nothing to publish/);
  assert.equal(deliveries, 1);
  const connections = readFileSync(executable + '.connections', 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(connections.length, 2);
  assert.notEqual(connections[0].headers.Authorization, connections[1].headers.Authorization);
  for (const connection of connections) await assert.rejects(post(connection, 'tools/list', 99));
});
