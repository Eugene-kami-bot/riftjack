import { routingInstructions } from '../src/routing-instructions.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createBackend } from '../src/backends.js';
import { loadConfig } from '../src/config.js';
import { State } from '../src/state.js';
import type { BackendReply } from '../src/media.js';
import { Bridge, type MatrixEvent } from '../src/bridge.js';
import { configForWorkspace } from '../src/workspace.js';
import { codexUsage } from '../src/codex-usage.js';
import { approvalInstructions } from '../src/approval-instructions.js';
import { OwnerDiagnosticError } from '../src/errors.js';

function setup(t: { after(fn: () => void): void }, accountType = 'chatgpt') {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-app-server-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-codex.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const lock = path.join(__dirname, 'active.lock');
fs.closeSync(fs.openSync(lock, 'wx'));
process.on('exit', () => fs.unlinkSync(lock));
const log = value => fs.appendFileSync(__filename + '.calls', JSON.stringify(value) + '\\n');
log({ args: process.argv.slice(2), cwd: process.cwd(), credentials: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'SYNAPSE_ADMIN_TOKEN', 'SYNAPSE_REGISTRATION_SHARED_SECRET', 'MATRIX_OWNER_ID'].filter(key => process.env[key]) });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const respond = (id, result) => send({ id, result });
const threadId = 'thread_1', turnId = 'turn_1';
let prompt = '', instructions = '', updates = [];
const turnError = () => fs.existsSync(path.join(__dirname, 'turn-error.json'))
  ? JSON.parse(fs.readFileSync(path.join(__dirname, 'turn-error.json'), 'utf8')) : null;
const complete = (text, status = 'completed') => {
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'comment', type: 'agentMessage', text: 'Checking the project.', phase: 'commentary' } } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text, phase: 'final_answer' } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [], error: turnError() } } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params: p } = message;
  if (method === 'initialize') return respond(id, {});
  if (method === 'initialized') return;
  if (method === 'account/read') return respond(id, { account: { type: ${JSON.stringify(accountType)} } });
  if (method === 'account/rateLimits/read') return respond(id, { rateLimits: { primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 86400 } } });
  if (method === 'plugin/read') return respond(id, { plugin: {
    marketplaceName: 'openai-curated-remote', description: 'Test GitHub integration',
    apps: [{ name: 'GitHub' }], mcpServers: ['github'],
    summary: { name: p.pluginName, installed: p.pluginName === 'installed', installPolicy: 'AVAILABLE', availability: 'AVAILABLE' }
  } });
  if (method === 'plugin/install') {
    if (p.pluginName === 'failure') return send({ id, error: { code: -32603, message: 'Secret diagnostic' } });
    return respond(id, { authPolicy: 'ON_USE', appsNeedingAuth: [{ name: 'GitHub', installUrl: 'https://github.test/login' }] });
  }
  if (method === 'thread/resume' && p.threadId === 'busy_thread') return send({ id, error: { code: -32600, message: 'thread busy_thread already has an active writer' } });
  if (method === 'thread/start' || method === 'thread/resume') {
    // Codex validates the transport even for a disabled MCP server.
    for (const [key, server] of Object.entries(p.config || {})) {
      if (key.startsWith('mcp_servers.') && !server.url && !server.command) {
        return send({ id, error: { code: -32600, message: 'failed to load configuration: invalid transport' } });
      }
    }
    if (p.developerInstructions !== undefined) instructions = p.developerInstructions;
    return respond(id, { thread: { id: threadId }, model: 'resolved-model', reasoningEffort: 'medium', serviceTier: 'default', cwd: process.cwd() });
  }
  if (method === 'thread/inject_items') {
    if (fs.existsSync(path.join(__dirname, 'reject-instructions'))) return send({ id, error: { code: -32603, message: 'Test injection failure' } });
    instructions = p.items[0].content[0].text;
    return respond(id, {});
  }
  if (method === 'turn/start') {
    prompt = p.input[0].text;
    if (prompt.includes('[immediate-fail]')) return respond(id, { turn: { id: turnId, status: 'failed', error: turnError() } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
    const begin = () => {
      respond(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      if (prompt.includes('[compact]')) {
        const item = { id: 'compact-1', type: 'contextCompaction' };
        send({ method: 'item/started', params: { threadId: 'other-thread', turnId, item } });
        send({ method: 'item/started', params: { threadId, turnId: 'other-turn', item } });
        for (let i = 0; i < 2; i++) send({ method: 'item/started', params: { threadId, turnId, item } });
        if (prompt.includes('[unfinished]')) return complete('', 'failed');
        for (let i = 0; i < 2; i++) send({ method: 'item/completed', params: { threadId, turnId, item } });
      }
      if (prompt.includes('[fail]')) return complete('', 'failed');
      if (prompt.includes('[wait]')) return;
      if (prompt.includes('[approval]')) return send({ id: 999, method: 'item/commandExecution/requestApproval', params: {} });
      if (prompt.includes('[confirm]')) {
        const params = { threadId: prompt.includes('[wrong-thread]') ? 'other' : threadId, turnId, itemId: 'command', command: 'echo approved', cwd: __dirname, availableDecisions: ['accept', 'decline'], reason: 'Test approval' };
        if (prompt.includes('[remember]') || prompt.includes('[auto-prefix]')) {
          params.proposedExecpolicyAmendment = ['echo', 'approved'];
          params.availableDecisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } });
          if (prompt.includes('[remember]')) params.reason += '\\nRiftjack-Persist: ' + JSON.stringify(params.proposedExecpolicyAmendment);
        }
        send({ id: 'approval-A', method: 'item/commandExecution/requestApproval', params });
        if (prompt.includes('[parallel]')) send({ id: 1001, method: 'item/commandExecution/requestApproval', params: { ...params, command: 'echo second' } });
        return;
      }
      if (prompt.includes('[form]')) return send({ id: 'approval-A', method: 'mcpServer/elicitation/request', params: {
        threadId, turnId: null, serverName: 'github', mode: 'form', message: 'Confirm operation',
        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
      } });
      if (prompt.includes('[question]')) return send({ id: 'approval-A', method: 'item/tool/requestUserInput', params: {
        threadId, turnId, itemId: 'question', questions: [{ id: 'color', question: 'Which color?', isSecret: false, options: null }]
      } });
      if (prompt.includes('[attachment]')) {
        const root = JSON.parse(instructions.split("conversation's outbox: ")[1].split('. It is emptied')[0]);
        fs.writeFileSync(path.join(root, 'answer.txt'), 'file contents');
        return complete('Here is the file.\\n' + String.fromCharCode(96).repeat(3) + 'matrix-attachments\\n' + JSON.stringify({ files: [{ path: 'answer.txt' }] }) + '\\n' + String.fromCharCode(96).repeat(3));
      }
      complete('done');
    };
    if (prompt.includes('[slow-start]')) setTimeout(begin, 30); else begin();
    return;
  }
  if (id === 999) return complete(message.result?.decision === 'decline' ? 'denied' : 'WRONG');
  if (id === 'approval-A' || id === 1001) {
    updates.push(id + ': ' + JSON.stringify(message.result));
    if (!prompt.includes('[parallel]') || updates.length === 2) complete(updates.join(' | '));
    return;
  }
  if (method === 'turn/steer') {
    const text = p.input[0].text;
    if (text.includes('[withdraw]')) send({ method: 'serverRequest/resolved', params: { threadId, requestId: 'approval-A' } });
    if (text.includes('[transport-failure]')) return process.exit(1);
    if (text.includes('[finish-race]')) {
      complete('finished before update');
      return send({ id, error: { code: -32600, message: 'No active turn' } });
    }
    if (text.includes('[reject]')) return send({ id, error: { code: -32600, message: 'Rejected' } });
    updates.push(text); respond(id, { turnId });
    if (text.includes('[finish]')) complete('steered: ' + updates.join(' | '));
    return;
  }
  if (method === 'turn/interrupt') { respond(id, {}); complete('', 'interrupted'); return; }
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: dir, CODEX_PATH: executable });
  const state = new State(join(dir, 'sessions.json'));
  const backend = createBackend(config, state);
  const calls = () => existsSync(executable + '.calls') ? readFileSync(executable + '.calls', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { dir, state, backend, calls, config };
}
const signal = () => new AbortController().signal;

test('Codex starts and resumes with unavailable connector MCP tools explicitly disabled', async t => {
  const f = setup(t);
  for (const prompt of ['First message', 'Continue']) {
    await f.backend('codex', prompt, 'conversation', signal(), '@owner:test');
  }
  const threads = f.calls().filter(c => c.method === 'thread/start' || c.method === 'thread/resume');
  assert.deepEqual(threads.map(c => c.method), ['thread/start', 'thread/resume']);
  assert.equal(threads[1].params.threadId, 'thread_1');
  for (const thread of threads) {
    for (const name of ['riftjack_publish', 'riftjack_tasks', 'riftjack_attachments', 'riftjack_rooms']) {
      const server = thread.params.config['mcp_servers.' + name];
      assert.equal(server.enabled, false);
      assert.ok(server.url || server.command);
      assert.equal(server.http_headers, undefined);
    }
  }
});

test('Codex refuses an unexpected resumed session before starting a turn', async t => {
  const f = setup(t);
  f.state.update('pinned', { codex: 'expected-thread' });
  await assert.rejects(f.backend('codex', 'hello', 'pinned', signal(), '@owner:test'), /different session/);
  assert.equal(f.state.session('pinned').codex, 'expected-thread');
  assert.equal(f.calls().some(call => call.method === 'turn/start'), false);
});

test('Codex model settings trim explicit values and leave blanks inherited', t => {
  const f = setup(t);
  const base = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.dir };
  for (const empty of [undefined, '', '  ']) {
    const config = loadConfig({ ...base, CODEX_MODEL: empty, CODEX_REASONING_EFFORT: empty, CODEX_SERVICE_TIER: empty });
    assert.equal(config.codexModel, undefined);
    assert.equal(config.codexReasoningEffort, undefined);
    assert.equal(config.codexServiceTier, undefined);
  }
  const config = loadConfig({ ...base, CODEX_MODEL: ' example-model ', CODEX_REASONING_EFFORT: ' high ', CODEX_SERVICE_TIER: ' default ' });
  assert.equal(config.codexModel, 'example-model');
  assert.equal(config.codexReasoningEffort, 'high');
  assert.equal(config.codexServiceTier, 'default');
});

test('Codex pins model, effort and tier for new and resumed conversations', async t => {
  const f = setup(t);
  for (const [model, effort, tier] of [['example-model', 'medium', 'priority'], ['other-model', 'high', 'default']]) {
    const backend = createBackend({ ...f.config, codexModel: model, codexReasoningEffort: effort, codexServiceTier: tier }, f.state);
    await backend('codex', 'hello', 'key', signal(), '@owner:test');
    const thread = f.calls().filter(c => c.method === 'thread/start' || c.method === 'thread/resume').at(-1);
    assert.equal(thread.method, tier === 'priority' ? 'thread/start' : 'thread/resume');
    assert.equal(thread.params.model, model);
    assert.equal(thread.params.serviceTier, tier);
    assert.equal(thread.params.config.model_reasoning_effort, effort);
    if (tier === 'default') assert.equal(thread.params.threadId, 'thread_1');
    const turn = f.calls().filter(c => c.method === 'turn/start').at(-1).params;
    assert.equal(turn.model, model);
    assert.equal(turn.effort, effort);
    assert.equal(turn.serviceTier, tier);
  }
  assert.equal(f.state.session('key').codex, 'thread_1');
});

test('unset Codex model settings omit overrides on new and resumed conversations', async t => {
  const f = setup(t);
  await f.backend('codex', 'hello', 'key', signal(), '@owner:test');
  await f.backend('codex', 'again', 'key', signal(), '@owner:test');
  for (const call of f.calls()) {
    if (call.method === 'thread/start' || call.method === 'thread/resume') {
      assert.equal(Object.hasOwn(call.params, 'model'), false);
      assert.equal(Object.hasOwn(call.params, 'serviceTier'), false);
      assert.equal(Object.hasOwn(call.params.config, 'model_reasoning_effort'), false);
    }
    if (call.method === 'turn/start') {
      for (const key of ['model', 'effort', 'serviceTier']) assert.equal(Object.hasOwn(call.params, key), false);
    }
  }
});

test('Codex usage reads account limits without creating a model turn and closes its process', async t => {
  const f = setup(t);
  assert.match(await codexUsage(f.config, signal()), /82%/);
  assert.deepEqual(f.calls().filter(c => c.method).map(c => c.method),
    ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.deepEqual(f.calls()[0].credentials, []);
  assert.equal(existsSync(join(f.dir, 'active.lock')), false);
});

test('Codex usage refuses non-ChatGPT auth and never starts when already aborted', async t => {
  const f = setup(t, 'apiKey');
  await assert.rejects(codexUsage(f.config, signal()), /ChatGPT/);
  assert.equal(f.calls().some(c => c.method === 'account/rateLimits/read'), false);
  const count = f.calls().length;
  await assert.rejects(codexUsage(f.config, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(f.calls().length, count);
});

test('per-bot Codex workspace reaches the process, thread cwd and attachment outbox', async t => {
  const f = setup(t);
  const project = join(f.dir, 'Other Project'); mkdirSync(project);
  const config = configForWorkspace(f.config, project);
  const backend = createBackend(config, f.state);
  const result = await backend('codex', '[attachment]', 'custom-room', signal(), '@owner:test') as BackendReply;
  assert.equal(f.calls().find(c => c.cwd)?.cwd, realpathSync(project));
  assert.equal(f.calls().find(c => c.method === 'thread/start').params.cwd, realpathSync(project));
  assert.ok(result.attachments[0].path.startsWith(join(realpathSync(project), '.matrix-media')));
  assert.equal(existsSync(join(f.config.workspace, '.matrix-media')), false);
});

test('connector instructions are Codex developer instructions, not part of the user message', async t => {
  const f = setup(t);
  await f.backend('codex', 'hello', 'key', signal(), '@owner:test');
  assert.match(f.calls().find(c => c.method === 'thread/start').params.developerInstructions, /conversation's outbox: ".*outbox"/);
  assert.ok(f.calls().find(c => c.method === 'thread/start').params.developerInstructions.includes(approvalInstructions('codex')));
  assert.ok(f.calls().find(c => c.method === 'thread/start').params.developerInstructions.includes(routingInstructions));
  assert.equal(f.calls().find(c => c.method === 'turn/start').params.input[0].text, 'hello');
  await f.backend('codex', 'continue', 'key', signal(), '@owner:test');
  assert.equal(f.calls().find(c => c.method === 'thread/resume').params.developerInstructions, undefined);
  assert.equal(f.calls().filter(c => c.method === 'thread/inject_items').length, 0);
});

test('existing Codex sessions receive approval judgment instructions once before the next model turn', async t => {
  const f = setup(t);
  f.state.update('key', { codex: 'thread_1', codexInstructionsHash: 'before-approval-judgment' });
  await f.backend('codex', 'continue', 'key', signal(), '@owner:test');
  const calls = f.calls();
  const injected = calls.findIndex(c => c.method === 'thread/inject_items');
  assert.ok(injected >= 0 && injected < calls.findIndex(c => c.method === 'turn/start'));
  assert.equal(calls[injected].params.items[0].role, 'developer');
  assert.ok(calls[injected].params.items[0].content[0].text.includes(approvalInstructions('codex')));
  assert.ok(calls[injected].params.items[0].content[0].text.includes(routingInstructions));
  assert.equal(calls.find(c => c.method === 'thread/resume').params.threadId, 'thread_1');
  await f.backend('codex', 'again', 'key', signal(), '@owner:test');
  assert.equal(f.calls().filter(c => c.method === 'thread/inject_items').length, 1);
  for (const call of f.calls().filter(c => c.method === 'thread/resume')) {
    assert.equal(call.params.developerInstructions, undefined);
  }
});

test('resuming a Codex conversation explicitly refreshes the attachment limit', async t => {
  const f = setup(t);
  const first = createBackend({ ...f.config, maxMediaBytes: 20 * 1024 * 1024 }, f.state);
  await first('codex', 'hello', 'key', signal(), '@owner:test');
  const next = createBackend({ ...f.config, maxMediaBytes: 512 * 1024 ** 2 }, f.state);
  await next('codex', '[attachment]', 'key', signal(), '@owner:test');
  const start = f.calls().find(c => c.method === 'thread/start').params;
  const resume = f.calls().find(c => c.method === 'thread/resume').params;
  assert.match(start.developerInstructions, /20971520 bytes each/);
  assert.equal(resume.developerInstructions, undefined);
  assert.equal(resume.threadId, 'thread_1');
  assert.equal(resume.config.developer_instructions, undefined);
  const calls = f.calls();
  const index = calls.findIndex(c => c.method === 'thread/inject_items');
  assert.ok(index > calls.findIndex(c => c.method === 'thread/resume'));
  assert.ok(index < calls.map(c => c.method).lastIndexOf('turn/start'));
  const item = calls[index].params.items[0];
  assert.equal(item.role, 'developer');
  assert.match(item.content[0].text, /536870912 bytes each/);
  assert.doesNotMatch(item.content[0].text, /20971520/);
  assert.ok(f.state.session('key').codexInstructionsHash);
  // A new backend and State instance exercise persistence across connector restarts.
  const reloaded = createBackend({ ...f.config, maxMediaBytes: 512 * 1024 ** 2 }, new State(join(f.dir, 'sessions.json')));
  await reloaded('codex', 'again', 'key', signal(), '@owner:test');
  assert.equal(f.calls().filter(c => c.method === 'thread/inject_items').length, 1);
});

test('existing Codex histories without an instruction hash receive an update', async t => {
  const f = setup(t);
  f.state.update('key', { codex: 'thread_1' });
  await f.backend('codex', 'hello', 'key', signal(), '@owner:test');
  assert.equal(f.calls().filter(c => c.method === 'thread/inject_items').length, 1);
});

test('failed instruction updates do not start a turn or mark instructions as current', async t => {
  const f = setup(t);
  f.state.update('key', { codex: 'thread_1', codexInstructionsHash: 'previous' });
  writeFileSync(join(f.dir, 'reject-instructions'), '');
  await assert.rejects(f.backend('codex', 'hello', 'key', signal(), '@owner:test'));
  assert.equal(f.calls().some(c => c.method === 'turn/start'), false);
  assert.equal(f.state.session('key').codexInstructionsHash, 'previous');
  rmSync(join(f.dir, 'reject-instructions'));
  await f.backend('codex', 'retry', 'key', signal(), '@owner:test');
  assert.equal(f.calls().filter(c => c.method === 'thread/inject_items').length, 2);
  assert.notEqual(f.state.session('key').codexInstructionsHash, 'previous');
});

test('Codex uses an independently installed executable from PATH by default', async t => {
  const f = setup(t);
  copyFileSync(f.config.codexPath, join(f.dir, 'codex'));
  const previous = process.env.PATH;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  process.env.PATH = [f.dir, previous].filter(Boolean).join(delimiter);
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.dir });
  const backend = createBackend(config, f.state);
  assert.equal(await backend('codex', 'hello', 'external-codex', signal(), '@owner:test'), 'done');
  assert.equal(f.state.session('external-codex').codex, 'thread_1');
});

test('missing Codex reports installation instructions without leaving a task active', async t => {
  const f = setup(t);
  const backend = createBackend({ ...f.config, codexPath: join(f.dir, 'not-installed') }, f.state);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(backend('codex', 'hello', 'missing-codex', signal(), '@owner:test'), /Install it on the host and set CODEX_PATH/);
  }
  assert.deepEqual(f.state.session('missing-codex'), {});
});

test('App Server preserves ChatGPT-only authentication, sandbox settings and conversation resumption', async t => {
  const f = setup(t);
  const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'SYNAPSE_ADMIN_TOKEN', 'SYNAPSE_REGISTRATION_SHARED_SECRET', 'MATRIX_OWNER_ID'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  for (const key of keys) process.env[key] = 'sentinel-not-a-real-key';
  assert.equal(await f.backend('codex', 'hello', 'conversation', signal(), '@owner:test'), 'done');
  assert.equal(await f.backend('codex', 'follow up', 'conversation', signal(), '@owner:test'), 'done');
  for (const call of f.calls().filter(c => c.args)) {
    assert.deepEqual(call.credentials, []);
    for (const arg of ['app-server', 'stdio://', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'sandbox_mode="workspace-write"', 'approval_policy="never"', 'sandbox_workspace_write.network_access=false', 'web_search="disabled"']) assert.ok(call.args.includes(arg));
  }
  const resumed = f.calls().find(c => c.method === 'thread/resume');
  assert.equal(resumed.params.threadId, 'thread_1');
  assert.equal(resumed.params.approvalPolicy, 'never'); assert.equal(resumed.params.sandbox, 'workspace-write');
  assert.equal(f.state.session('conversation').codex, 'thread_1');
  await assert.rejects(f.backend('codex', '[fail]', 'conversation', signal(), '@owner:test'), /task failed/);
  assert.equal(await f.backend('codex', 'retry', 'conversation', signal(), '@owner:test'), 'done');
});

test('Codex reports structured cyber policy failures without exposing diagnostics or retrying', async t => {
  for (const prompt of ['[fail]', '[immediate-fail]']) {
    const f = setup(t);
    writeFileSync(join(f.dir, 'turn-error.json'), JSON.stringify({
      codexErrorInfo: 'cyberPolicy', message: 'private diagnostic', additionalDetails: 'private details',
    }));
    await assert.rejects(f.backend('codex', prompt, 'conversation', signal(), '@owner:test'), error => {
      assert.match(String(error), /safety filter.*possible cybersecurity risk.*cyberPolicy/);
      assert.doesNotMatch(String(error), /private|retry/i);
      assert.ok(error instanceof OwnerDiagnosticError);
      assert.equal(error.ownerDetails(), 'private diagnostic\n\nprivate details');
      return true;
    });
    assert.equal(f.calls().filter(c => c.method === 'turn/start').length, 1);
    assert.equal(f.state.session('conversation').codex, 'thread_1');
  }
});

test('Codex does not infer a policy category from free text or unknown error values', async t => {
  for (const codexErrorInfo of [null, 'futureCategory-private', { cyberPolicy: 'private' }]) {
    const f = setup(t);
    writeFileSync(join(f.dir, 'turn-error.json'), JSON.stringify({
      codexErrorInfo, message: 'cyberPolicy private diagnostic', additionalDetails: 'private details',
    }));
    await assert.rejects(f.backend('codex', '[fail]', 'conversation', signal(), '@owner:test'),
      { message: 'Codex task failed.' });
  }
});

test('Codex success is not overridden by a policy field on the turn', async t => {
  const f = setup(t);
  writeFileSync(join(f.dir, 'turn-error.json'), JSON.stringify({ codexErrorInfo: 'cyberPolicy' }));
  assert.equal(await f.backend('codex', 'hello', 'conversation', signal(), '@owner:test'), 'done');
});

test('API-key accounts cannot start a model turn', async t => {
  const f = setup(t, 'apiKey');
  await assert.rejects(f.backend('codex', 'hello', 'key', signal(), '@owner:test'), /ChatGPT account/);
  assert.ok(!f.calls().some(c => c.method === 'turn/start'));
});

test('native images and local audio/file metadata survive the App Server transport and attachment reply parsing', async t => {
  const f = setup(t);
  const attachments = [
    { path: join(f.dir, 'image.png'), name: 'image.png', image: true, mimetype: 'image/png', size: 10 },
    { path: join(f.dir, 'audio.ogg'), name: 'audio.ogg', image: false, mimetype: 'audio/ogg', size: 10,
      transcription: { status: 'complete' as const, text: 'Example spoken request.', automatic: true as const } },
    { path: join(f.dir, 'notes.txt'), name: 'notes.txt', image: false, mimetype: 'text/plain', size: 10 },
  ];
  const reply = await f.backend('codex', '[attachment]', 'key', signal(), '@owner:test', attachments) as BackendReply;
  const input = f.calls().find(c => c.method === 'turn/start').params.input;
  assert.deepEqual(input[1], { type: 'localImage', path: attachments[0].path });
  assert.equal(input.length, 2); assert.ok(input[0].text.includes(attachments[1].path)); assert.ok(input[0].text.includes(attachments[2].path));
  assert.ok(input[0].text.includes(JSON.stringify(attachments[1].transcription)));
  assert.equal(reply.text, 'Here is the file.'); assert.equal(readFileSync(reply.attachments[0].path, 'utf8'), 'file contents');
});

test('steering during startup reaches the same active turn with text and images, without restarting', async t => {
  const f = setup(t);
  const run = f.backend('codex', '[wait] [slow-start]', 'key', signal(), '@owner:test');
  const image = { path: '/image.png', name: 'image.png', image: true, mimetype: 'image/png', size: 1 };
  assert.equal(await f.backend.steer('Use this picture', 'key', signal(), '@owner:test', [image]), true);
  assert.equal(await f.backend.steer('Make it blue [finish]', 'key', signal(), '@owner:test'), true);
  assert.match(String(await run), /Use this picture[\s\S]*Make it blue/);
  const calls = f.calls();
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(calls.filter(c => c.args).length, 1);
  const steers = calls.filter(c => c.method === 'turn/steer');
  assert.equal(steers[0].params.expectedTurnId, 'turn_1'); assert.equal(steers[0].params.threadId, 'thread_1');
  assert.deepEqual(steers[0].params.input[1], { type: 'localImage', path: '/image.png' });
  assert.ok(!calls.some(c => c.method === 'turn/interrupt'));
});

test('other conversations and senders cannot steer; other conversations run in parallel', async t => {
  const f = setup(t);
  const run = f.backend('codex', '[wait]', 'key', signal(), '@owner:test');
  assert.equal(await f.backend.steer('wrong room', 'other-key', signal(), '@owner:test'), false);
  assert.equal(await f.backend.steer('wrong sender', 'key', signal(), '@guest:test'), false);
  await assert.rejects(f.backend('codex', 'duplicate', 'key', signal(), '@owner:test'), /already running in this conversation/);
  assert.equal(await f.backend.steer('[finish]', 'key', signal(), '@owner:test'), true);
  await run;
  assert.equal(f.calls().filter(c => c.method === 'turn/steer').length, 1);
});

test('completion race returns a follow-up result only after an explicit steering rejection', async t => {
  const f = setup(t);
  const run = f.backend('codex', '[wait]', 'key', signal(), '@owner:test');
  assert.equal(await f.backend.steer('[finish-race]', 'key', signal(), '@owner:test'), false);
  assert.equal(await run, 'finished before update');
  assert.equal(await f.backend.steer('late update', 'key', signal(), '@owner:test'), false);
  assert.equal(await f.backend('codex', 'late update', 'key', signal(), '@owner:test'), 'done');
});

test('steering rejection does not kill the original task or silently enqueue duplicate work', async t => {
  const f = setup(t);
  const run = f.backend('codex', '[wait]', 'key', signal(), '@owner:test');
  await assert.rejects(f.backend.steer('[reject]', 'key', signal(), '@owner:test'), /rejected/);
  assert.equal(await f.backend.steer('[finish]', 'key', signal(), '@owner:test'), true);
  assert.equal(await run, 'steered: [finish]');
});

test('transport failure rejects both the task and its unconfirmed steering request', async t => {
  const f = setup(t);
  const run = f.backend('codex', '[wait]', 'key', signal(), '@owner:test');
  const failedRun = assert.rejects(run, /exited/);
  await assert.rejects(f.backend.steer('[transport-failure]', 'key', signal(), '@owner:test'), /exited/);
  await failedRun;
});

test('cancellation interrupts the active turn and waits for child exit before allowing another task', async t => {
  const f = setup(t);
  const controller = new AbortController();
  const run = f.backend('codex', '[wait]', 'key', controller.signal, '@owner:test');
  const stopped = assert.rejects(run);
  await f.backend.steer('update', 'key', controller.signal, '@owner:test');
  controller.abort();
  await stopped;
  assert.ok(f.calls().some(c => c.method === 'turn/interrupt'));
  assert.equal(await f.backend('codex', 'next', 'key', signal(), '@owner:test'), 'done');
});

test('cancellation during server startup does not start a model turn', async t => {
  const f = setup(t);
  const controller = new AbortController();
  const run = f.backend('codex', 'hello', 'key', controller.signal, '@owner:test');
  const stopped = assert.rejects(run);
  controller.abort(); await stopped;
  assert.ok(!f.calls().some(c => c.method === 'turn/start'));
});

test('unsolicited approval requests are declined without changing permissions', async t => {
  const f = setup(t);
  assert.equal(await f.backend('codex', '[approval]', 'key', signal(), '@owner:test'), 'denied');
  assert.deepEqual(f.calls().find(c => c.id === 999).result, { decision: 'decline' });
});

test('Matrix bridge and App Server deliver steering end to end without a second model turn', async t => {
  const f = setup(t);
  const replies: string[] = [];
  let running!: () => void;
  const ready = new Promise<void>(resolve => { running = resolve; });
  const bridge = new Bridge({
    botId: '@bot:test', owner: '@owner:test', kind: 'codex', since: 0, timeoutMs: 5000, state: f.state,
    isAuthorized: user => user === '@owner:test', isPrivateRoom: async () => true,
    run: async (...args) => { const result = f.backend(...args); running(); return result; },
    steer: f.backend.steer, reply: async (_room, _event, text) => { replies.push(text); },
    report: () => assert.fail('Unexpected bridge error'),
  });
  const event = (id: string, body: string): MatrixEvent => ({ event_id: id, type: 'm.room.message', sender: '@owner:test', origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
  const task = bridge.handle('!dm:test', event('$first', '[wait]'));
  await ready;
  await bridge.handle('!dm:test', event('$update', 'Use blue [finish]'));
  await task;
  assert.ok(replies.includes('Added your message to the current task.'));
  assert.equal(replies.at(-1), 'steered: Use blue [finish]');
  assert.equal(f.calls().filter(c => c.method === 'turn/start').length, 1);
  assert.equal(f.calls().filter(c => c.method === 'turn/steer').length, 1);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Timed out waiting for fake App Server');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function confirming(t: { after(fn: () => void): void }) {
  const f = setup(t);
  const replies: string[] = [], errors: unknown[] = [];
  let allowed = true, privateRoom = true, eventId = 0;
  const bridge = new Bridge({
    botId: '@bot:test', owner: '@owner:test', kind: 'codex', since: 1000, timeoutMs: 5000, state: f.state,
    isAuthorized: () => allowed, isPrivateRoom: async () => privateRoom,
    run: f.backend, steer: f.backend.steer,
    confirmation: async (_room, _event, text, controls, markdown) => {
      assert.match(markdown, /^### Confirmation /);
      replies.push(text); controls.bind('$request-' + replies.length);
    },
    reply: async (_room, _event, text) => { replies.push(text); }, report: error => errors.push(error),
    receive: async () => ({ path: '/file', name: 'caption', size: 1, image: false, mimetype: 'text/plain' }),
  });
  t.after(() => bridge.stop());
  const event = (body: string): MatrixEvent => ({ event_id: '$confirmation-' + ++eventId, type: 'm.room.message', sender: '@owner:test', origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
  const confirmations = () => replies.filter(text => text.startsWith('Confirmation '));
  const id = (index = 0) => /^Confirmation ([a-f0-9]{12})/.exec(confirmations()[index])![1];
  return { ...f, bridge, replies, errors, event, confirmations, id,
    reactionTarget: () => '$request-' + (replies.findIndex(text => text.startsWith('Confirmation ')) + 1),
    revoke: () => { allowed = false; bridge.revoke('@owner:test'); }, publicRoom: () => { privateRoom = false; } };
}

test('ordinary messages in any language steer the task without answering a pending confirmation', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm]'));
  await until(() => f.confirmations().length === 1);
  const updates = ['yes', 'no', 'Подтверждаю', 'нет', 'はい', 'いいえ', 'نعم', 'non', 'Explain the command first.'];
  for (const text of updates) {
    await f.bridge.handle('!dm:test', f.event(text));
    assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
  }
  assert.deepEqual(f.calls().filter(c => c.method === 'turn/steer').map(c => c.params.input[0].text), updates);
  await f.bridge.handle('!dm:test', f.event(`!deny ${f.id()}`));
  await task;
  assert.deepEqual(f.calls().find(c => c.id === 'approval-A').result, { decision: 'decline' });
  assert.equal(f.calls().filter(c => c.method === 'turn/start').length, 1);
  assert.deepEqual(f.errors, []);
});

for (const verb of ['approve', 'deny']) for (const withId of [true, false, 'reaction'] as const) test(`Matrix ${verb} ${withId === 'reaction' ? 'reaction' : withId ? 'with ID' : 'without ID'} answers the exact server request without steering and ignores replay`, async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm]'));
  await until(() => f.confirmations().length === 1);
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
  assert.match(f.confirmations()[0], /echo approved/);
  const answer = withId === 'reaction' ? { ...f.event(''), type: 'm.reaction', content: {
    'm.relates_to': { rel_type: 'm.annotation', event_id: f.reactionTarget(), key: verb === 'approve' ? '✅' : '❌' },
  } } : f.event(`!${verb}${withId ? ' ' + f.id() : ''}`);
  await f.bridge.handle('!dm:test', answer);
  await task;
  await f.bridge.handle('!dm:test', answer);
  await f.bridge.handle('!dm:test', f.event(`!${verb} ${f.id()}`));
  assert.equal(f.calls().filter(c => c.id === 'approval-A').length, 1);
  assert.deepEqual(f.calls().find(c => c.id === 'approval-A').result, { decision: verb === 'approve' ? 'accept' : 'decline' });
  assert.equal(f.calls().filter(c => c.method === 'turn/start').length, 1);
  assert.equal(f.calls().filter(c => c.method === 'turn/steer').length, 0);
  assert.ok(f.calls().find(c => c.args).args.includes('approval_policy="on-request"'));
  assert.equal(f.calls().find(c => c.method === 'thread/start').params.approvalsReviewer, 'user');
  assert.deepEqual(f.errors, []);
});

for (const bookmark of [false, true]) test(`Matrix remember ${bookmark ? 'reaction' : 'command'} sends the exact persistent decision once without steering or accepting foreign answers`, async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm] [remember]'));
  await until(() => f.confirmations().length === 1);
  const text = `!answer ${f.id()} remember`;
  const reaction = () => ({ ...f.event(''), type: 'm.reaction', content: {
    'm.relates_to': { rel_type: 'm.annotation', event_id: f.reactionTarget(), key: '🔖' },
  } });
  await f.bridge.handle('!other:test', reaction());
  await f.bridge.handle('!dm:test', { ...reaction(), sender: '@stranger:test' });
  await f.bridge.handle('!dm:test', { ...reaction(), content: {
    'm.relates_to': { rel_type: 'm.annotation', event_id: '$unrelated', key: '🔖' },
  } });
  await f.bridge.handle('!other:test', f.event(text));
  await f.bridge.handle('!dm:test', { ...f.event(text), sender: '@stranger:test' });
  await f.bridge.handle('!dm:test', { ...f.event(text), content: { msgtype: 'm.text', body: text,
    'm.relates_to': { rel_type: 'm.thread', event_id: '$other-thread' } } });
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
  const answer = bookmark ? reaction() : f.event(text);
  await f.bridge.handle('!dm:test', answer);
  await task;
  await f.bridge.handle('!dm:test', answer);
  await f.bridge.handle('!dm:test', reaction());
  await f.bridge.handle('!dm:test', f.event(text));
  assert.deepEqual(f.calls().filter(c => c.id === 'approval-A').map(c => c.result), [
    { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'approved'] } } },
  ]);
  assert.equal(f.calls().filter(c => c.method === 'turn/steer').length, 0);
  assert.deepEqual(f.errors, []);
});

test('a server-generated prefix without agent intent cannot be saved by text or reaction', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm] [auto-prefix]'));
  await until(() => f.confirmations().length === 1);
  assert.doesNotMatch(f.confirmations()[0], /🔖|Approve and remember/);
  await f.bridge.handle('!dm:test', f.event(`!answer ${f.id()} remember`));
  await f.bridge.handle('!dm:test', { ...f.event(''), type: 'm.reaction', content: {
    'm.relates_to': { rel_type: 'm.annotation', event_id: f.reactionTarget(), key: '🔖' },
  } });
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
  await f.bridge.handle('!dm:test', f.event(`!approve ${f.id()}`));
  await task;
  assert.deepEqual(f.calls().filter(c => c.id === 'approval-A').map(c => c.result), [{ decision: 'accept' }]);
  assert.deepEqual(f.errors, []);
});

test('a guest cannot save shared Codex rules even when the server proposes one', async t => {
  const f = setup(t);
  await f.backend('codex', '[confirm] [remember]', 'guest', signal(), '@guest:test', [], async request => {
    assert.equal(request.answer, undefined);
    assert.deepEqual(request.approve, { decision: 'accept' });
    return request.deny;
  });
  assert.deepEqual(f.calls().find(c => c.id === 'approval-A').result, { decision: 'decline' });
});

test('another sender, room, thread, edited event, caption or old event cannot approve', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm]'));
  await until(() => f.confirmations().length === 1);
  const text = `!approve ${f.id()}`;
  await f.bridge.handle('!other:test', f.event(text));
  await f.bridge.handle('!dm:test', { ...f.event(text), sender: '@guest:test' });
  await f.bridge.handle('!dm:test', { ...f.event(text), origin_server_ts: 500 });
  for (const rel_type of ['m.thread', 'm.replace']) {
    await f.bridge.handle('!dm:test', { ...f.event(text), content: { msgtype: 'm.text', body: text, 'm.relates_to': { rel_type, event_id: '$other' } } });
  }
  await f.bridge.handle('!dm:test', { ...f.event(text), content: { msgtype: 'm.notice', body: text } });
  await f.bridge.handle('!dm:test', { ...f.event(text), content: { msgtype: 'm.file', body: text } });
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
  // Matrix reply fallbacks must be removed, not sent as instructions to the model.
  await f.bridge.handle('!dm:test', { ...f.event(text), content: { msgtype: 'm.text', body: `> <@bot:test> Confirmation\n> Request text\n\n${text}`, 'm.relates_to': { 'm.in_reply_to': { event_id: '$bot-message' } } } });
  await task;
  assert.deepEqual(f.calls().find(c => c.id === 'approval-A').result, { decision: 'accept' });
});

test('parallel confirmation IDs route independently and support string and numeric RPC IDs', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm] [parallel]'));
  await until(() => f.confirmations().length === 2);
  await f.bridge.handle('!dm:test', f.event('!approve'));
  assert.match(f.replies.at(-1)!, /More than one/);
  assert.equal(f.calls().some(c => c.id === 'approval-A' || c.id === 1001), false);
  await f.bridge.handle('!dm:test', f.event(`!deny ${f.id(1)}`));
  await f.bridge.handle('!dm:test', f.event('!approve'));
  await task;
  assert.deepEqual(f.calls().find(c => c.id === 1001).result, { decision: 'decline' });
  assert.deepEqual(f.calls().find(c => c.id === 'approval-A').result, { decision: 'accept' });
});

test('MCP form validation keeps the request pending until an explicit valid answer', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[form]'));
  await until(() => f.confirmations().length === 1);
  await f.bridge.handle('!dm:test', f.event(`!approve ${f.id()}`));
  await f.bridge.handle('!dm:test', f.event(`!answer ${f.id()} {"confirm":"yes"}`));
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
  await f.bridge.handle('!dm:test', f.event('!answer {"confirm":true}'));
  await task;
  assert.deepEqual(f.calls().find(c => c.id === 'approval-A').result, { action: 'accept', content: { confirm: true }, _meta: null });
});

test('agent questions receive structured answers rather than new model messages', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[question]'));
  await until(() => f.confirmations().length === 1);
  await f.bridge.handle('!dm:test', f.event('!answer blue'));
  await task;
  assert.deepEqual(f.calls().find(c => c.id === 'approval-A').result, { answers: { color: { answers: ['blue'] } } });
  assert.equal(f.calls().some(c => c.method === 'turn/steer'), false);
});

test('server withdrawal expires the ID without a second RPC response', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm]'));
  await until(() => f.confirmations().length === 1);
  await f.bridge.handle('!dm:test', f.event('[withdraw]'));
  await f.bridge.handle('!dm:test', f.event(`!approve ${f.id()}`));
  assert.match(f.replies.at(-1)!, /unknown, expired/);
  await f.bridge.handle('!dm:test', f.event('[finish]'));
  await task;
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
});

for (const end of ['cancel', 'revoke', 'finish', 'crash']) test(`${end} expires confirmations and releases the workspace`, async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm]'));
  await until(() => f.confirmations().length === 1);
  if (end === 'revoke') f.revoke();
  else await f.bridge.handle('!dm:test', f.event(end === 'cancel' ? '!cancel' : end === 'crash' ? '[transport-failure]' : '[finish]'));
  await task;
  await f.bridge.handle('!dm:test', f.event(`!approve ${f.id()}`));
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
  assert.equal(f.bridge.busy, false);
});

test('changed room membership prevents an answer reaching the server', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('[confirm]'));
  await until(() => f.confirmations().length === 1);
  f.publicRoom();
  await f.bridge.handle('!dm:test', f.event(`!approve ${f.id()}`));
  f.bridge.stop(); await task;
  assert.equal(f.calls().some(c => c.id === 'approval-A'), false);
});

test('wrong-thread requests and never policy are declined without an interactive prompt', async t => {
  const f = confirming(t);
  await f.bridge.handle('!dm:test', f.event('[confirm] [wrong-thread]'));
  f.config.codexApprovalPolicy = 'never';
  await f.bridge.handle('!dm:test', f.event('[confirm]'));
  assert.equal(f.confirmations().length, 0);
  assert.ok(f.calls().filter(c => c.id === 'approval-A').every(c => c.result.decision === 'decline'));
});

for (const verb of ['approve', 'deny']) test(`plugin installation ${verb} uses local RPCs and never starts a model turn`, async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('!plugin install github'));
  await until(() => f.confirmations().length === 1);
  assert.match(f.confirmations()[0], /Test GitHub integration/);
  assert.equal(f.calls().some(c => c.method === 'plugin/install'), false);
  await f.bridge.handle('!dm:test', f.event(`!${verb}`));
  await task;
  assert.equal(f.calls().filter(c => c.method === 'plugin/install').length, verb === 'approve' ? 1 : 0);
  assert.equal(f.calls().some(c => c.method === 'thread/start' || c.method === 'turn/start'), false);
  if (verb === 'approve') {
    assert.deepEqual(f.calls().find(c => c.method === 'plugin/install').params, { pluginName: 'github', remoteMarketplaceName: 'openai-curated-remote' });
    assert.match(f.replies.at(-1)!, /Browser authentication is still required/);
    assert.match(f.replies.at(-1)!, /https:\/\/github.test\/login/);
  }
});

test('only owner can install; malformed plugin commands are not prompts; installed plugins are not reinstalled', async t => {
  const f = confirming(t);
  await f.bridge.handle('!dm:test', { ...f.event('!plugin install github'), sender: '@guest:test' });
  await f.bridge.handle('!dm:test', f.event('!plugin install ../../plugin'));
  assert.equal(f.calls().length, 0);
  await f.bridge.handle('!dm:test', f.event('!plugin install installed'));
  assert.equal(f.confirmations().length, 0);
  assert.equal(f.calls().some(c => c.method === 'plugin/install'), false);
  assert.match(f.replies.at(-1)!, /already installed/);
});

test('failed plugin installation reports uncertain state without retrying or claiming success', async t => {
  const f = confirming(t);
  const task = f.bridge.handle('!dm:test', f.event('!plugin install failure'));
  await until(() => f.confirmations().length === 1);
  await f.bridge.handle('!dm:test', f.event(`!approve ${f.id()}`)); await task;
  assert.equal(f.calls().filter(c => c.method === 'plugin/install').length, 1);
  assert.match(f.replies.at(-1)!, /installation was not confirmed/);
  assert.doesNotMatch(f.replies.at(-1)!, /Secret diagnostic/);
});


test('busy Codex conversations explain the conflict without resetting history or starting a turn', async t => {
  const f = setup(t);
  f.state.update('busy-conversation', { codex: 'busy_thread' });
  const { errorMessage } = await import('../src/errors.js');
  await assert.rejects(f.backend('codex', 'hello', 'busy-conversation', signal(), '@owner:test'), error => {
    const message = errorMessage(error);
    assert.match(message, /already open in another Codex process/);
    assert.match(message, /No conversation reset is needed/);
    assert.doesNotMatch(message, /busy_thread/);
    return true;
  });
  assert.equal(f.state.session('busy-conversation').codex, 'busy_thread');
  assert.equal(f.calls().some(call => call.method === 'turn/start' || call.method === 'thread/start'), false);
  assert.equal(existsSync(join(f.dir, 'active.lock')), false);
});

test('Codex RPC diagnostics expose only recognized actionable messages', async () => {
  const { RpcError } = await import('../src/app-server.js');
  const { errorMessage } = await import('../src/errors.js');
  for (const message of ['private server diagnostic', 'thread busy_thread already has an active writer\nprivate secret', null]) {
    assert.equal(errorMessage(new RpcError(-32600, message)), 'Codex App Server rejected request (RPC -32600).');
  }
});

test('Codex status records CLI-reported values, refreshes on resume and stays conversation-scoped', async t => {
  const f = setup(t);
  const backend = createBackend({ ...f.config, codexModel: 'requested-alias', codexReasoningEffort: 'high', codexServiceTier: 'priority' }, f.state);
  await backend('codex', 'hello', 'key', signal(), '@owner:test');
  const report = f.state.session('key').codexReport!;
  assert.equal(report.model, 'resolved-model');
  assert.equal(report.reasoningEffort, 'medium');
  assert.equal(report.serviceTier, 'default');
  assert.equal(report.cwd, realpathSync(f.dir));
  assert.ok(Number.isFinite(Date.parse(report.reportedAt)));
  assert.equal(f.state.session('another-key').codexReport, undefined);
  assert.deepEqual(new State(join(f.dir, 'sessions.json')).session('key').codexReport, report);
  f.state.update('key', { codexReport: { reportedAt: report.reportedAt, model: 'outdated' } });
  await backend('codex', 'again', 'key', signal(), '@owner:test');
  assert.equal(f.state.session('key').codexReport!.model, 'resolved-model');
  f.state.reset('key');
  assert.equal(f.state.session('key').codexReport, undefined);
});


test('Codex forwards completed commentary separately from the final response', async t => {
  const f = setup(t);
  const updates: string[] = [];
  const result = await f.backend('codex', 'hello', 'progress-conversation', signal(), '@owner:test', [], undefined, undefined,
    { progress: async text => { updates.push(text); } });
  assert.deepEqual(updates, ['Checking the project.']);
  assert.doesNotMatch(typeof result === 'string' ? result : result.text, /Checking the project/);
});

test('Codex snapshots dynamic settings per task and refreshes them on resume', async t => {
  const f = setup(t), settings = { ...f.config, codexModel: 'first-model', codexReasoningEffort: 'high', codexServiceTier: 'priority' };
  const backend = createBackend(() => settings, f.state);
  const first = backend('codex', 'hello', 'dynamic', signal(), '@owner:test');
  settings.codexModel = 'second-model'; settings.codexReasoningEffort = 'medium'; settings.codexServiceTier = 'default';
  await first;
  assert.equal(f.calls().filter(c => c.method === 'turn/start').at(-1).params.model, 'first-model');
  await backend('codex', 'hello again', 'dynamic', signal(), '@owner:test');
  const thread = f.calls().filter(c => c.method === 'thread/resume').at(-1).params;
  assert.equal(thread.model, 'second-model');
  const turn = f.calls().filter(c => c.method === 'turn/start').at(-1).params;
  assert.equal(turn.model, 'second-model'); assert.equal(turn.effort, 'medium'); assert.equal(turn.serviceTier, 'default');
  assert.equal(f.state.session('dynamic').codex, 'thread_1');
});

for (const unfinished of [false, true]) test(`Codex compaction notifications, unfinished=${unfinished}`, async t => {
  const f = setup(t), phases: string[] = [];
  const task = f.backend('codex', '[compact]' + (unfinished ? '[unfinished]' : ''), 'key', signal(), '@owner:test', [], undefined, undefined,
    { compaction: async phase => { phases.push(phase); } });
  if (unfinished) await assert.rejects(task, /task failed/); else await task;
  assert.deepEqual(phases, ['started', unfinished ? 'unconfirmed' : 'completed']);
});
