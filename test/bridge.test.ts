import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, messageParts, sessionKey, type Backend, type MatrixEvent, type Mode } from '../src/bridge.js';
import { isPrivateRoom } from '../src/private-room.js';
import { State } from '../src/state.js';
import { RestartController, RESTART_EXIT_CODE } from '../src/restart.js';
import { Accounts, provision } from '../src/accounts.js';
import { parseProfileRequest, resolveProfileTarget } from '../src/bot-profile.js';
import { loadConfig } from '../src/config.js';
import { errorMessage, OwnerDiagnosticError } from '../src/errors.js';

function event(body = 'hello', id = '$1'): MatrixEvent {
  return { event_id: id, sender: '@owner:test', type: 'm.room.message', origin_server_ts: 2000, content: { body, msgtype: 'm.text' } };
}

function reaction(target: string, key = '✅', id = '$reaction'): MatrixEvent {
  return { type: 'm.reaction', event_id: id, sender: '@owner:test', origin_server_ts: 2000,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key } } };
}

test('typing covers backend work and final delivery, but not local commands or denied messages', async t => {
  const calls: boolean[] = [], ready = gate(), finish = gate();
  const f = fixture(t, 'codex', async () => { ready.release(); await finish.promise; return 'done'; }, true, {
    typing: async (_room, typing) => { calls.push(typing); },
    reply: async (_room, _event, text) => { if (text === 'done') assert.equal(calls.at(-1), true); },
  });
  await f.bridge.handle('!dm:test', event('!status', '$status'));
  await f.bridge.handle('!dm:test', { ...event('hello', '$denied'), sender: '@other:test' });
  assert.deepEqual(calls, []);
  const task = f.bridge.handle('!dm:test', event()); await ready.promise;
  assert.deepEqual(calls, [true]);
  finish.release(); await task;
  assert.equal(calls.at(-1), false);
  // Final delivery may already clear the indicator before task cleanup does.
  assert.equal(calls.filter(typing => typing).length, 1);
});

for (const end of ['failure', 'cancel', 'stop'] as const) test(`typing clears after task ${end}`, async t => {
  const calls: boolean[] = [], ready = gate();
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal) => {
    ready.release();
    if (end === 'failure') throw new Error('failed');
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    signal.throwIfAborted(); return 'done';
  }, true, { typing: async (_room, typing) => { calls.push(typing); } });
  const task = f.bridge.handle('!dm:test', event()); await ready.promise;
  if (end === 'cancel') await f.bridge.handle('!dm:test', event('!cancel', '$cancel'));
  if (end === 'stop') f.bridge.stop();
  await task;
  assert.equal(calls[0], true);
  assert.equal(calls.at(-1), false);
  assert.equal(calls.filter(typing => typing).length, 1);
});

test('manager accepts avatar names and reports target errors before downloading images', async t => {
  let accounts!: Accounts, downloads = 0;
  const f = fixture(t, 'manager', undefined, true, {
    acceptManagerAvatar: (prompt, sender) => {
      const request = parseProfileRequest(prompt);
      return request?.action === 'avatar' && !!resolveProfileTarget(accounts, request.userId, sender, '@owner:test');
    },
    receive: async () => { downloads++; return { path: '/avatar.png', name: 'avatar.png', mimetype: 'image/png', image: true, size: 1 }; },
  });
  accounts = new Accounts(f.file + '.accounts');
  accounts.add({ userId: '@bot_codex_codex_123456abcdef:test', accessToken: 'test', kind: 'codex', name: 'Riftjack Codex' });
  const avatarEvent = (body: string, id: string) => ({ ...event(body, id), content: { msgtype: 'm.image', body } });
  await f.bridge.handle('!dm:test', avatarEvent('set avatar Riftjack Codex', '$avatar-name'));
  await f.bridge.handle('!dm:test', avatarEvent('set avatar bot_codex_codex', '$avatar-alias'));
  assert.equal(downloads, 2);
  await f.bridge.handle('!dm:test', avatarEvent('set avatar Missing', '$avatar-missing'));
  assert.match(f.replies.at(-1)!, /No bot found/);
  accounts.add({ ...accounts.list()[0], userId: '@other:test' });
  await f.bridge.handle('!dm:test', avatarEvent('set avatar Riftjack Codex', '$avatar-ambiguous'));
  assert.match(f.replies.at(-1)!, /Several bots.*full Matrix ID/);
  assert.equal(downloads, 2);
  assert.equal(f.calls.length, 2);
});

test('reaction approvals scope to the sender, room and bound threaded request, once only', async t => {
  const ready = gate();
  const results: object[] = [], replies: MatrixEvent[] = [];
  let count = 0;
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal, _sender, _attachments, interact) => {
    await Promise.all([1, 2].map(async n => {
      results.push(await interact!({ text: 'Request ' + n, approve: { n, ok: true }, deny: { n, ok: false } }, signal));
    }));
    return 'done';
  }, true, {
    isAuthorized: user => ['@owner:test', '@other:test', '@bot:test'].includes(user),
    confirmation: async (_room, _event, _text, controls) => { controls.bind('$confirmation' + ++count); if (count === 2) ready.release(); },
    reply: async (_room, original) => { replies.push(original); },
  });
  const original = { ...event(), content: { body: 'Run', msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
  const task = f.bridge.handle('!dm:test', original);
  await ready.promise;
  const bad = [
    { ...reaction('$confirmation1'), sender: '@other:test' },
    { ...reaction('$confirmation1'), sender: '@bot:test' },
    { ...reaction('$confirmation1'), origin_server_ts: 999 },
    { ...reaction('$confirmation1'), origin_server_ts: undefined },
    { ...reaction('$confirmation1'), event_id: undefined },
    { ...reaction('$confirmation1'), type: 'm.room.redaction' },
    reaction('$thread'), reaction('$confirmation1', '👍'),
    { ...reaction('$confirmation1'), content: { 'm.relates_to': { rel_type: 'm.replace', event_id: '$confirmation1', key: '✅' } } },
  ];
  for (const e of bad) await f.bridge.handle('!dm:test', e);
  await f.bridge.handle('!elsewhere:test', reaction('$confirmation1'));
  assert.deepEqual(results, []);
  await f.bridge.handle('!dm:test', reaction('$confirmation2', '❌', '$deny'));
  assert.deepEqual(results, [{ n: 2, ok: false }]);
  await f.bridge.handle('!dm:test', reaction('$confirmation1', '✅', '$approve'));
  await task;
  await f.bridge.handle('!dm:test', reaction('$confirmation1', '❌', '$replay'));
  assert.deepEqual(results, [{ n: 2, ok: false }, { n: 1, ok: true }]);
  assert.ok(replies.every(e => e === original));
  assert.deepEqual(f.errors, []);
});

test('reaction approval rechecks room privacy and revoked access before resolving', async t => {
  for (const reason of ['room', 'access', 'cancel']) {
    const ready = gate();
    let allowed = true, privateRoom = true, decided = false;
    const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal, _sender, _attachments, interact) => {
      await interact!({ text: 'Run?', approve: {}, deny: {} }, signal); decided = true; return 'done';
    }, true, {
      isAuthorized: () => allowed,
      isPrivateRoom: async () => privateRoom,
      confirmation: async (_room, _event, _text, controls) => { controls.bind('$confirmation'); ready.release(); },
    });
    const task = f.bridge.handle('!dm:test', event()); await ready.promise;
    if (reason === 'room') privateRoom = false;
    if (reason === 'access') allowed = false;
    if (reason === 'cancel') f.bridge.stop();
    if (reason === 'room') await assert.rejects(f.bridge.handle('!dm:test', reaction('$confirmation')), /membership changed/);
    else await f.bridge.handle('!dm:test', reaction('$confirmation'));
    assert.equal(decided, false);
    f.bridge.stop(); await task;
  }
});
function fixture(t: { after(fn: () => void): void }, kind: Mode = 'codex', runner?: Backend, privateRoom = true,
  options: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const state = new State(file);
  const calls: string[] = [], replies: string[] = [], errors: unknown[] = [];
  const bridge = new Bridge({
    botId: '@bot:test', owner: '@owner:test', isAuthorized: user => user === '@owner:test', kind, since: 1000, timeoutMs: 1000, state,
    isPrivateRoom: async () => privateRoom,
    run: runner || (async (mode, prompt, key) => { calls.push(mode + ':' + prompt); state.update(key, { codex: 'thread_1' }); return 'answer'; }),
    reply: async (_room, _event, text) => { replies.push(text); }, report: error => errors.push(error), ...options,
  });
  return { bridge, calls, replies, errors, state, file };
}

test('task diagnostics use a separate owner route and never replace the public failure', async t => {
  const error = new OwnerDiagnosticError('Public failure', 'owner-only details');
  const deliveries: unknown[] = [];
  const f = fixture(t, 'codex', async () => { throw error; }, true, {
    isAuthorized: () => true,
    ownerDiagnostic: async (e, context) => { deliveries.push({ e, context }); throw new Error('delivery failed'); },
  });
  await f.bridge.handle('!shared:test', event());
  assert.deepEqual(deliveries, [{ e: error, context: { room: '!shared:test', sender: '@owner:test' } }]);
  assert.equal(f.replies.at(-1), 'Public failure');
  assert.ok(f.replies.every(text => !text.includes('owner-only')));
  await f.bridge.handle('!guest:test', { ...event('hello', '$2'), sender: '@guest:test' });
  assert.equal(deliveries.length, 1);
});

for (const kind of ['codex', 'claude', 'manager'] as const) test(kind + ' DMs work without mentions or commands', async t => {
  const f = fixture(t, kind);
  await f.bridge.handle('!dm:test', event('Hello there'));
  assert.deepEqual(f.calls, [kind + ':Hello there']);
  assert.equal(f.replies.at(-1), 'answer');
});

for (const kind of ['codex', 'claude', 'manager'] as const) test(kind + ' formats task replies and all help responses', async t => {
  const replies: { text: string; markdown: boolean; msgtype: string }[] = [];
  const f = fixture(t, kind, undefined, true, {
    reply: async (_room, _event, text, markdown = false, msgtype = 'm.notice') => { replies.push({ text, markdown, msgtype }); },
  });
  await f.bridge.handle('!dm:test', event('Hello'));
  assert.equal(replies.at(-1)!.markdown, true);
  assert.equal(replies.at(-1)!.msgtype, 'm.text');
  assert.ok(replies.slice(0, -1).every(reply => reply.msgtype === 'm.notice'));
  assert.ok(replies.slice(0, -1).every(reply => !reply.markdown));
  await f.bridge.handle('!dm:test', event('!help', '$help-format'));
  assert.equal(replies.at(-1)!.markdown, true);
  assert.equal(replies.at(-1)!.msgtype, 'm.notice');
  await f.bridge.handle('!dm:test', event('x'.repeat(16_001), '$long-help-format'));
  assert.equal(replies.at(-1)!.markdown, true);
  assert.match(replies.at(-1)!.text, /Help/);
  assert.equal(replies.at(-1)!.msgtype, 'm.notice');
});

for (const kind of ['codex', 'claude', 'manager'] as const) test(kind + ' rejects unknown or malformed bang commands locally', async t => {
  const f = fixture(t, kind);
  const commands = ['!', '!!help', '!aprove 090554f4ea24', '!unknown', '!help extra', '!reset extra', '!cancel extra', '!restart extra', '!approve-extra', '  !unknown\nplease run this'];
  for (const [i, command] of commands.entries()) {
    const incoming = event(command, '$unknown-' + i);
    await f.bridge.handle('!dm:test', incoming);
    await f.bridge.handle('!dm:test', incoming);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.replies.length, commands.length);
  assert.ok(f.replies.every(reply => /Unknown command.*!help/.test(reply)));
  assert.deepEqual(f.state.session(sessionKey('!dm:test', event())), {});
});

test('unknown commands in Matrix replies are rejected after removing the quote', async t => {
  const f = fixture(t);
  await f.bridge.handle('!dm:test', { ...event(), content: {
    msgtype: 'm.text', body: '> <@bot:test> Use !approve\n\n!aprove',
    'm.relates_to': { 'm.in_reply_to': { event_id: '$bot-message' } },
  } });
  assert.deepEqual(f.calls, []);
  assert.match(f.replies[0], /Unknown command/);
});

test('unknown commands never steer or enqueue follow-ups during an active task', async t => {
  const started = gate(), finish = gate();
  let runs = 0, steers = 0;
  const f = fixture(t, 'codex', async () => {
    runs++; started.release(); await finish.promise; return 'done';
  }, true, { steer: async () => { steers++; return false; } });
  const task = f.bridge.handle('!dm:test', event('Build it'));
  await started.promise;
  await f.bridge.handle('!dm:test', event('!aprove', '$typo'));
  await f.bridge.handle('!dm:test', event('!cancel extra', '$malformed'));
  assert.match(f.replies.at(-1)!, /Unknown command/);
  finish.release(); await task;
  assert.equal(runs, 1); assert.equal(steers, 0);
  assert.equal(f.replies.at(-1), 'done');
});

test('manager provisioning diagnostics reach both chat and logging with the same safe detail', async t => {
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.example', MATRIX_OWNER_ID: '@owner:test',
    RIFTJACK_WORKSPACE: process.cwd(), SYNAPSE_ADMIN_TOKEN: 'private-admin-token', SYNAPSE_ADMIN_URL: 'http://127.0.0.1:18008' });
  const fake = (async (url) => {
    if (String(url).endsWith('/whoami')) return Response.json({ user_id: '@admin:test' });
    throw new TypeError('private-admin-token', { cause: { code: 'ECONNREFUSED' } });
  }) as typeof fetch;
  const f = fixture(t, 'manager', async (_mode, _prompt, _key, signal) => {
    await provision(config, 'codex', 'Builder', signal, fake);
    return 'created';
  });
  await f.bridge.handle('!dm:test', event('create a Codex bot called Builder'));
  assert.equal(f.errors.length, 1);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0], errorMessage(f.errors[0]));
  assert.match(f.replies[0], /check account availability.*ECONNREFUSED.*SSH tunnel/);
  assert.doesNotMatch(f.replies[0], /private-admin-token|terminal/);
});

test('unexpected task failures include safe nested diagnostics in chat', async t => {
  const f = fixture(t, 'codex', async () => { throw new TypeError('secret-token', { cause: { code: 'ECONNRESET' } }); });
  await f.bridge.handle('!dm:test', event());
  assert.match(f.replies.at(-1)!, /Task failed: TypeError, ECONNRESET/);
  assert.doesNotMatch(f.replies.at(-1)!, /secret-token/);
});

test('unauthorized, old, edited, notice and bot messages do not run', async t => {
  const f = fixture(t);
  const events = [
    { ...event(), sender: '@stranger:test' }, { ...event(), sender: '@bot:test' },
    { ...event(), origin_server_ts: 999 }, { ...event(), origin_server_ts: undefined },
    { ...event(), content: { body: 'hello', msgtype: 'm.notice' } },
    { ...event(), content: { body: 'edited', msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.replace' } } },
  ];
  for (const e of events) await f.bridge.handle('!dm:test', e);
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
});

test('group or unencrypted rooms cannot run a task', async t => {
  const f = fixture(t, 'codex', undefined, false);
  await f.bridge.handle('!group:test', event());
  assert.equal(f.calls.length, 0);
});

test('duplicate deliveries only run once and survive restart', async t => {
  const f = fixture(t);
  await Promise.all([f.bridge.handle('!dm:test', event()), f.bridge.handle('!dm:test', event())]);
  assert.equal(f.calls.length, 1);
  assert.equal(new State(f.file).claim(JSON.stringify(['@bot:test', '$1'])), false);
});

test('separate DMs and threads have separate conversations; reset persists', async t => {
  const f = fixture(t);
  const a = event();
  const b = { ...event(), content: { body: 'hello', msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } };
  const key = sessionKey('!dm:test', a);
  assert.notEqual(key, sessionKey('!other:test', a));
  assert.notEqual(key, sessionKey('!dm:test', b));
  await f.bridge.handle('!dm:test', a);
  assert.equal(new State(f.file).session(key).codex, 'thread_1');
  await f.bridge.handle('!dm:test', event('!reset', '$2'));
  assert.deepEqual(new State(f.file).session(key), {});
});

test('busy messages do not overlap tasks; cancel aborts the active task', async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return '';
  });
  const first = f.bridge.handle('!dm:test', event());
  await ready;
  await f.bridge.handle('!dm:test', event('second task', '$2'));
  assert.match(f.replies.at(-1)!, /task is running/);
  await f.bridge.handle('!dm:test', event('!cancel', '$3'));
  await first;
  assert.ok(f.replies.some(r => r.includes('Task cancelled')));
});

test('long Unicode responses preserve text and stay within event size', () => {
  const text = '😀hello'.repeat(5000);
  const parts = messageParts(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => Buffer.byteLength(JSON.stringify(p)) < 60_000));
});

for (const msgtype of ['m.image', 'm.file', 'm.audio']) test(msgtype + ' reaches the backend with its attachment and cannot act as !reset', async t => {
  const attachment = { path: '/workspace/incoming/file', name: '!reset', mimetype: 'application/octet-stream', size: 4, image: false };
  let downloads = 0, runs = 0;
  const f = fixture(t, 'codex', async (mode, prompt, _key, _signal, _sender, attachments) => {
    assert.equal(mode, 'codex'); assert.equal(prompt, '!reset'); assert.deepEqual(attachments, [attachment]);
    runs++; return 'received';
  }, true, { receive: async () => { downloads++; return attachment; } });
  const incoming = { ...event(), content: { msgtype, body: '!reset' } };
  await f.bridge.handle('!dm:test', incoming);
  await f.bridge.handle('!dm:test', incoming);
  assert.equal(downloads, 1); assert.equal(runs, 1); assert.equal(f.replies.at(-1), 'received');
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} receives automatic transcript with its original audio`, async t => {
  const file = { path: '/audio.ogg', name: 'audio.ogg', size: 10, image: false, mimetype: 'audio/ogg' };
  const transcription = { status: 'complete' as const, text: '!reset is spoken data', automatic: true as const };
  let calls = 0;
  const f = fixture(t, kind, async (_mode, _prompt, _key, _signal, _sender, files) => {
    calls++; assert.deepEqual(files, [{ ...file, transcription }]); return 'received';
  }, true, { receive: async () => file, transcribe: async attachment => ({ ...attachment, transcription }) });
  await f.bridge.handle('!dm:test', { ...event(), content: { msgtype: 'm.audio', body: 'voice.ogg' } });
  assert.equal(calls, 1);
});

test('revocation during transcription prevents delivery to the backend', async t => {
  let allowed = true;
  const f = fixture(t, 'codex', undefined, true, {
    isAuthorized: () => allowed,
    receive: async () => ({ path: '/audio', name: 'audio', size: 1, image: false, mimetype: 'audio/ogg' }),
    transcribe: async file => { allowed = false; return file; },
  });
  await f.bridge.handle('!dm:test', { ...event(), content: { msgtype: 'm.audio', body: 'voice.ogg' } });
  assert.equal(f.calls.length, 0);
});

test('unauthorized media and manager attachments never download or execute commands', async t => {
  let downloads = 0;
  const options = { receive: async () => { downloads++; throw new Error('Unexpected download'); } };
  const incoming = { ...event(), content: { msgtype: 'm.file', body: 'create a Codex bot called Surprise' } };
  const codex = fixture(t, 'codex', undefined, true, options);
  await codex.bridge.handle('!dm:test', { ...incoming, sender: '@stranger:test' });
  const group = fixture(t, 'codex', undefined, false, options);
  await group.bridge.handle('!group:test', incoming);
  const manager = fixture(t, 'manager', undefined, true, options);
  await manager.bridge.handle('!dm:test', incoming);
  assert.equal(downloads, 0); assert.equal(manager.calls.length, 0);
  assert.match(manager.replies.at(-1)!, /set avatar/);
});

test('manager downloads only explicitly accepted avatar images and rejects other attachment commands', async t => {
  let downloads = 0, runs = 0;
  const f = fixture(t, 'manager', async (mode, prompt, _key, _signal, _sender, attachments) => {
    runs++;
    assert.equal(mode, 'manager'); assert.equal(prompt, 'set avatar @target:test');
    assert.equal(attachments?.length, 1);
    return 'avatar updated';
  }, true, {
    acceptManagerAvatar: (prompt, sender) => prompt === 'set avatar @target:test' && sender === '@owner:test',
    receive: async () => { downloads++; return { path: '/avatar.png', name: 'avatar.png', image: true, size: 10, mimetype: 'image/png' }; },
  });
  for (const [index, body] of ['create a Codex bot called Surprise', 'rename bot @target:test to Surprise', '!restart', 'set avatar @other:test'].entries()) {
    await f.bridge.handle('!dm:test', { ...event(body, '$reject' + index), content: { msgtype: 'm.image', body } });
  }
  await f.bridge.handle('!dm:test', { ...event('ignored', '$audio'), content: { msgtype: 'm.audio', body: 'set avatar @target:test' } });
  assert.equal(downloads, 0); assert.equal(runs, 0);
  const incoming = { ...event('ignored', '$avatar'), content: { msgtype: 'm.image', body: 'set avatar @target:test' } };
  await f.bridge.handle('!dm:test', incoming);
  await f.bridge.handle('!dm:test', incoming);
  assert.equal(downloads, 1); assert.equal(runs, 1);
  assert.equal(f.replies.at(-1), 'avatar updated');
});

test('cancellation during attachment download does not invoke Codex', async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(t, 'codex', undefined, true, { receive: async (_event, _key, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    throw new Error('Unexpected completion');
  } });
  const pending = f.bridge.handle('!dm:test', { ...event(), content: { msgtype: 'm.audio', body: 'Voice message' } });
  await ready;
  await f.bridge.handle('!dm:test', event('!cancel', '$cancel'));
  await pending;
  assert.equal(f.calls.length, 0); assert.match(f.replies.at(-1)!, /Task cancelled/);
});

test('attachment replies go through the media sender with the original event', async t => {
  const files = [{ root: '/workspace/outbox', path: '/workspace/outbox/picture.png' }];
  const incoming = event();
  let sends = 0;
  const f = fixture(t, 'codex', async () => ({ text: '', attachments: files }), true, {
    sendAttachments: async (room, original, attachments, signal) => {
      assert.equal(room, '!dm:test'); assert.equal(original, incoming); assert.deepEqual(attachments, files);
      assert.equal(signal.aborted, false); sends++;
    },
  });
  await f.bridge.handle('!dm:test', incoming);
  assert.equal(sends, 1); assert.deepEqual(f.replies, []);
});

for (const kind of ['codex', 'claude', 'manager'] as const) test(kind + ' handles owner !restart locally and ignores replay', async t => {
  let restarts = 0;
  const f = fixture(t, kind, undefined, true, { restart: async reply => { await reply('Restarting'); restarts++; } });
  const incoming = event('!restart');
  await f.bridge.handle('!dm:test', incoming);
  await f.bridge.handle('!dm:test', incoming);
  assert.equal(restarts, 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.replies, ['Restarting']);
});

for (const command of ['!restart', '!restart supervisor']) for (const reverse of [false, true])
test(`${command} is claimed across bots before acknowledgement, stopping replies and process replacement (reverse=${reverse})`, async t => {
  const base = fixture(t), ready = gate(), release = gate();
  const replies: string[] = [], exits: number[] = [];
  const restart = new RestartController({ supported: true, supervisorSupported: true, busy: () => false,
    shutdown: code => exits.push(code) });
  const bots = ['@first:test', '@second:test'].map(botId => fixture(t, 'codex', undefined, true, {
    botId, state: base.state, isStopping: () => restart.pending,
    restart: (reply, target, scope) => restart.request(reply, target, scope),
    reply: async (_room, _event, text) => {
      replies.push(text);
      if (replies.length === 1) { ready.release(); await release.promise; }
    },
  }));
  if (reverse) bots.reverse();
  const incoming = event(command, '$shared-restart');
  const first = bots[0].bridge.handle('!shared:test', incoming);
  await ready.promise;
  await bots[1].bridge.handle('!shared:test', incoming);
  assert.equal(replies.length, 1);
  assert.deepEqual(exits, []);
  release.release(); await first;
  assert.equal(exits.length, 1);
  bots[1].bridge.stop();
  await bots[1].bridge.handle('!shared:test', incoming);
  assert.equal(replies.length, 1);
  // Use a third bot so this exercises the global persisted claim, not its own
  // per-bot duplicate filter or the startup timestamp cutoff.
  const replacement = fixture(t, 'codex', undefined, true, {
    botId: '@third:test', state: new State(base.file),
    restart: async () => assert.fail('replayed restart'),
  });
  await replacement.bridge.handle('!shared:test', incoming);
  assert.deepEqual(replacement.replies, []);
  assert.deepEqual(bots.flatMap(bot => bot.errors), []);
});

test('shared restart refusal is delivered once and a new command can retry', async t => {
  const base = fixture(t);
  let busy = true;
  const exits: number[] = [];
  const restart = new RestartController({ supported: true, busy: () => busy, shutdown: code => exits.push(code) });
  const bots = ['@first:test', '@second:test'].map(botId => fixture(t, 'codex', undefined, true, {
    botId, state: base.state, isStopping: () => restart.pending,
    restart: (reply, target, scope) => restart.request(reply, target, scope),
  }));
  await Promise.all(bots.map(bot => bot.bridge.handle('!shared:test', event('!restart', '$busy'))));
  assert.equal(bots.flatMap(bot => bot.replies).length, 1);
  assert.match(bots.flatMap(bot => bot.replies)[0], /busy/);
  assert.deepEqual(exits, []);
  busy = false;
  await Promise.all(bots.map(bot => bot.bridge.handle('!shared:test', event('!restart', '$retry'))));
  assert.deepEqual(exits, [RESTART_EXIT_CODE]);
  assert.equal(bots.flatMap(bot => bot.replies).length, 2);
});

test('another bot does not retry a shared restart after uncertain acknowledgement delivery', async t => {
  const base = fixture(t);
  const exits: number[] = [];
  let sends = 0;
  const restart = new RestartController({ supported: true, busy: () => false, shutdown: code => exits.push(code) });
  const bots = ['@first:test', '@second:test'].map(botId => fixture(t, 'codex', undefined, true, {
    botId, state: base.state,
    restart: (reply, target, scope) => restart.request(reply, target, scope),
    reply: async () => { if (++sends === 1) throw new Error('uncertain send'); },
  }));
  await bots[0].bridge.handle('!shared:test', event('!restart', '$uncertain'));
  await bots[1].bridge.handle('!shared:test', event('!restart', '$uncertain'));
  assert.equal(sends, 1); assert.deepEqual(exits, []);
  await bots[1].bridge.handle('!shared:test', event('!restart', '$explicit-retry'));
  assert.equal(sends, 2); assert.deepEqual(exits, [RESTART_EXIT_CODE]);
});

test('restart forwards the exact requesting bot, room, event, owner and thread', async t => {
  const f = fixture(t, 'codex', undefined, true, { restart: async (reply, target) => {
    assert.deepEqual(target, { botId: '@bot:test', roomId: '!another:test', sender: '@owner:test', eventId: '$restart', threadId: '$root' });
    await reply('Restarting');
  } });
  await f.bridge.handle('!another:test', { ...event('!restart', '$restart'), content: {
    body: '!restart', msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
  } });
  assert.deepEqual(f.replies, ['Restarting']);
});

for (const kind of ['codex', 'claude', 'manager'] as const) test(kind + ' routes explicit supervisor restart locally, owner-only and once', async t => {
  let restarts = 0;
  const f = fixture(t, kind, undefined, true, { isAuthorized: () => true, restart: async (reply, target, scope) => {
    assert.equal(scope, 'supervisor'); assert.equal(target.sender, '@owner:test');
    restarts++; await reply('Restarting supervisor');
  } });
  await f.bridge.handle('!dm:test', { ...event('!restart supervisor', '$guest'), sender: '@guest:test' });
  assert.equal(restarts, 0);
  const incoming = event('!restart supervisor', '$owner');
  await f.bridge.handle('!dm:test', incoming);
  await f.bridge.handle('!dm:test', incoming);
  assert.equal(restarts, 1); assert.deepEqual(f.calls, []);
});

test('allowed non-owners cannot restart, nor can old, edited, notice, or group events', async t => {
  let restarts = 0;
  const options = { restart: async () => { restarts++; }, isAuthorized: () => true };
  const f = fixture(t, 'codex', undefined, true, options);
  await f.bridge.handle('!dm:test', { ...event('!restart'), sender: '@guest:test' });
  assert.match(f.replies.at(-1)!, /Only the initial owner/);
  await f.bridge.handle('!dm:test', { ...event('!restart', '$old'), origin_server_ts: 500 });
  await f.bridge.handle('!dm:test', { ...event('!restart', '$edit'), content: { msgtype: 'm.text', body: '!restart', 'm.relates_to': { rel_type: 'm.replace' } } });
  await f.bridge.handle('!dm:test', { ...event('!restart', '$notice'), content: { msgtype: 'm.notice', body: '!restart' } });
  const group = fixture(t, 'codex', undefined, false, options);
  await group.bridge.handle('!group:test', event('!restart'));
  assert.equal(restarts, 0); assert.equal(f.calls.length, 0);
});

test('restart text in an attachment caption does not restart the connector', async t => {
  let restarts = 0;
  const f = fixture(t, 'codex', undefined, true, {
    restart: async () => { restarts++; },
    receive: async () => ({ path: '/file', name: '!restart', size: 0, image: false, mimetype: 'text/plain' }),
  });
  await f.bridge.handle('!dm:test', { ...event(), content: { msgtype: 'm.file', body: '!restart' } });
  assert.equal(restarts, 0); assert.deepEqual(f.calls, ['codex:!restart']);
});

test('pending restart or shutdown prevents starting new tasks', async t => {
  for (const shutdown of [false, true]) {
    const f = fixture(t, 'codex', undefined, true, { isStopping: () => !shutdown });
    if (shutdown) f.bridge.stop();
    await f.bridge.handle('!dm:test', event());
    assert.equal(f.calls.length, 0); assert.match(f.replies.at(-1)!, /restarting or stopping/);
  }
});

test('owner restart refuses an active task and succeeds after it finishes without resetting its session', async t => {
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const done = new Promise<void>(resolve => { finish = resolve; });
  const exits: number[] = [];
  const restart = new RestartController({ supported: true, busy: () => f.bridge.busy, shutdown: code => exits.push(code) });
  const f = fixture(t, 'codex', async (_mode, _prompt, key) => {
    started(); await done; f.state.update(key, { codex: 'preserved-thread' }); return 'done';
  }, true, { restart: reply => restart.request(reply) });
  const task = f.bridge.handle('!dm:test', event());
  await ready;
  await f.bridge.handle('!dm:test', event('!restart', '$restart-busy'));
  assert.match(f.replies.at(-1)!, /busy/); assert.deepEqual(exits, []);
  finish(); await task;
  await f.bridge.handle('!dm:test', event('!restart', '$restart-idle'));
  assert.deepEqual(exits, [RESTART_EXIT_CODE]);
  assert.equal(f.state.session(sessionKey('!dm:test', event())).codex, 'preserved-thread');
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('same-conversation messages steer in order, once, without cancelling or running another task', async t => {
  const started = gate(), finish = gate();
  const updates: string[] = [];
  let runs = 0;
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal) => {
    runs++; started.release(); await finish.promise; assert.equal(signal.aborted, false); return 'updated answer';
  }, true, { steer: async prompt => { updates.push(prompt); return true; } });
  const task = f.bridge.handle('!dm:test', event('Build it'));
  await started.promise;
  await f.bridge.handle('!dm:test', event('Make it blue', '$2'));
  await f.bridge.handle('!dm:test', event('Make it blue', '$2'));
  await f.bridge.handle('!dm:test', event('Use larger text', '$3'));
  finish.release(); await task;
  assert.deepEqual(updates, ['Make it blue', 'Use larger text']); assert.equal(runs, 1);
  assert.equal(f.replies.filter(r => r.includes('Added your message')).length, 2);
  assert.equal(f.replies.at(-1), 'updated answer');
});

test('steering received before the initial backend starts waits for readiness', async t => {
  const preparing = gate(), prepared = gate(), finish = gate();
  let running = false, steered = false;
  const f = fixture(t, 'codex', async () => { running = true; await finish.promise; return 'done'; }, true, {
    receive: async () => { preparing.release(); await prepared.promise; return { path: '/note.txt', name: 'note.txt', mimetype: 'text/plain', size: 1, image: false }; },
    steer: async () => { assert.equal(running, true); steered = true; return true; },
  });
  const task = f.bridge.handle('!dm:test', { ...event(), content: { msgtype: 'm.file', body: 'hello' } });
  await preparing.promise;
  const update = f.bridge.handle('!dm:test', event('clarification', '$2'));
  prepared.release(); await update;
  assert.equal(steered, true); finish.release(); await task;
});

test('a just-completed turn processes unsteered messages next and preserves their attachments', async t => {
  const started = gate(), finish = gate();
  const prompts: string[] = [], replyIds: string[] = [];
  const image = { path: '/picture.png', name: 'picture.png', image: true, mimetype: 'image/png', size: 3 };
  const f = fixture(t, 'codex', async (_mode, prompt, _key, _signal, _sender, attachments) => {
    prompts.push(prompt);
    if (prompts.length === 1) { started.release(); await finish.promise; }
    else assert.deepEqual(attachments, [image]);
    return 'answer';
  }, true, {
    receive: async () => image,
    steer: async () => { finish.release(); return false; },
    reply: async (_room, original, text) => { if (text === 'answer') replyIds.push(original.event_id!); },
  });
  const task = f.bridge.handle('!dm:test', event('first'));
  await started.promise;
  await f.bridge.handle('!dm:test', { ...event('use this', '$2'), content: { msgtype: 'm.image', body: 'use this' } });
  await task;
  assert.deepEqual(prompts, ['first', 'use this']); assert.deepEqual(replyIds, ['$1', '$2']);
});

test('another room, thread or sender cannot inject steering into the active conversation', async t => {
  const started = gate(), finish = gate();
  let steers = 0;
  const f = fixture(t, 'codex', async () => { started.release(); await finish.promise; return 'done'; }, true, {
    isAuthorized: () => true, steer: async () => { steers++; return true; },
  });
  const task = f.bridge.handle('!dm:test', event()); await started.promise;
  await f.bridge.handle('!other:test', event('other room', '$2'));
  await f.bridge.handle('!dm:test', { ...event('other sender', '$3'), sender: '@guest:test' });
  await f.bridge.handle('!dm:test', { ...event('other thread', '$4'), content: { msgtype: 'm.text', body: 'hello', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } });
  await f.bridge.handle('!dm:test', event('!reset', '$5'));
  assert.equal(steers, 0); finish.release(); await task;
});

test('cancelling discards queued follow-ups and does not call a second backend turn', async t => {
  const started = gate(); let runs = 0;
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal) => {
    runs++; started.release();
    await new Promise<void>((_yes, no) => signal.addEventListener('abort', () => no(new Error('aborted')), { once: true }));
    return '';
  }, true, { steer: async () => false });
  const task = f.bridge.handle('!dm:test', event()); await started.promise;
  await f.bridge.handle('!dm:test', event('follow up', '$2'));
  await f.bridge.handle('!dm:test', event('!cancel', '$3'));
  await task;
  assert.equal(runs, 1); assert.match(f.replies.at(-1)!, /Pending follow-ups were discarded/);
});

test('revocation during a steering attachment download prevents delivery to Codex', async t => {
  const started = gate(), downloading = gate(), downloaded = gate(), finish = gate();
  let allowed = true, steers = 0;
  const f = fixture(t, 'codex', async () => { started.release(); await finish.promise; return 'done'; }, true, {
    isAuthorized: () => allowed,
    receive: async () => { downloading.release(); await downloaded.promise; return { path: '/file', name: 'file', image: false, mimetype: 'text/plain', size: 1 }; },
    steer: async () => { steers++; return true; },
  });
  const task = f.bridge.handle('!dm:test', event()); await started.promise;
  const update = f.bridge.handle('!dm:test', { ...event('file', '$2'), content: { msgtype: 'm.file', body: 'file' } });
  await downloading.promise; allowed = false; f.bridge.revoke('@owner:test'); downloaded.release();
  await update; finish.release(); await task;
  assert.equal(steers, 0);
});

test('failed steering is reported without silently repeating it as another task', async t => {
  const started = gate(), finish = gate(); let runs = 0;
  const f = fixture(t, 'codex', async () => { runs++; started.release(); await finish.promise; return 'original answer'; }, true, {
    steer: async () => { throw new Error('Unknown delivery status'); },
  });
  const task = f.bridge.handle('!dm:test', event()); await started.promise;
  await f.bridge.handle('!dm:test', event('update', '$2'));
  assert.match(f.replies.at(-1)!, /Could not confirm delivery/);
  finish.release(); await task; assert.equal(runs, 1);
});

test('too-long steering and more than ten pending messages are rejected before backend delivery', async t => {
  const started = gate(); let steers = 0;
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal) => {
    started.release();
    await new Promise<void>((_yes, no) => signal.addEventListener('abort', () => no(new Error('aborted')), { once: true }));
    return '';
  }, true, { steer: async () => { steers++; return false; } });
  const task = f.bridge.handle('!dm:test', event()); await started.promise;
  await f.bridge.handle('!dm:test', event('a'.repeat(16001), '$long'));
  for (let i = 0; i < 11; i++) await f.bridge.handle('!dm:test', event('update', '$update' + i));
  assert.equal(steers, 10); assert.match(f.replies.at(-1)!, /Too many pending/);
  await f.bridge.handle('!dm:test', event('!cancel', '$cancel')); await task;
});


test('the real room guard blocks processing and confirmation after a third-party invitation', async t => {
  const roomState = [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...['@bot:test', '@owner:test'].map(state_key => ({ type: 'm.room.member', state_key, content: { membership: 'join' } })),
  ];
  let invited = true, decided = false;
  const ready = gate();
  const client = { getRoomState: async () => [...roomState,
    ...(invited ? [{ type: 'm.room.member', state_key: '@third:test', content: { membership: 'invite' } }] : [])] };
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal, _sender, _attachments, interact) => {
    await interact!({ text: 'Run?', approve: {}, deny: {} }, signal);
    decided = true; return 'done';
  }, true, {
    isPrivateRoom: (room, sender) => isPrivateRoom(client, room, '@bot:test', sender, () => true),
    confirmation: async (_room, _event, _text, controls) => { controls.bind('$confirmation'); ready.release(); },
  });
  await f.bridge.handle('!dm:test', event());
  assert.equal(f.bridge.busy, false); assert.deepEqual(f.replies, []);
  invited = false;
  const task = f.bridge.handle('!dm:test', event('Run', '$safe')); await ready.promise;
  invited = true;
  await f.bridge.handle('!dm:test', event('!approve', '$command'));
  await assert.rejects(f.bridge.handle('!dm:test', reaction('$confirmation')), /membership changed/);
  assert.equal(decided, false);
  f.bridge.stop(); await task;
});


test('task timeout withdraws a pending confirmation and reports timeout instead of cancellation', async t => {
  let approved = false;
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, signal, _sender, _attachments, interact) => {
    await interact!({ text: 'Run?', approve: {}, deny: {} }, signal);
    approved = true; return 'done';
  }, true, { timeoutMs: 20 });
  await f.bridge.handle('!dm:test', event());
  assert.equal(approved, false);
  assert.equal(f.bridge.busy, false);
  assert.match(f.replies.at(-1)!, /^Task timed out\./);
  await f.bridge.handle('!dm:test', event('!approve', '$late'));
  assert.match(f.replies.at(-1)!, /No pending confirmation/);
});

for (const kind of ['codex', 'claude'] as const) test(`!status (${kind}) is local, scoped and available during a task`, async t => {
  const started = gate(), finish = gate();
  const keys: string[] = [];
  let runs = 0, steers = 0;
  const f = fixture(t, kind, async () => { runs++; started.release(); await finish.promise; return 'done'; }, true, {
    status: key => { keys.push(key); return '**Status details**'; },
    steer: async () => { steers++; return true; },
  });
  await f.bridge.handle('!dm:test', event('!status', '$idle'));
  assert.match(f.replies.at(-1)!, /Task:.*Idle/);
  assert.equal(runs, 0);
  const task = f.bridge.handle('!dm:test', event('work', '$work'));
  await started.promise;
  try {
    await f.bridge.handle('!dm:test', event('!status', '$running'));
    assert.match(f.replies.at(-1)!, /Task:.*Running/);
    await f.bridge.handle('!elsewhere:test', event('!status', '$elsewhere'));
    assert.match(f.replies.at(-1)!, /Busy in another conversation/);
    const threaded = { ...event('!status', '$thread-status'), content: { body: '!status', msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
    await f.bridge.handle('!dm:test', threaded);
    assert.equal(keys.at(-1), sessionKey('!dm:test', threaded));
    assert.match(f.replies.at(-1)!, /Busy in another conversation/);
    const count = keys.length;
    await f.bridge.handle('!dm:test', { ...event('!status', '$unauthorized'), sender: '@stranger:test' });
    await f.bridge.handle('!dm:test', event('!status extra', '$bad-syntax'));
    await f.bridge.handle('!dm:test', event('!status', '$running')); // replay
    assert.equal(keys.length, count);
    assert.equal(runs, 1);
    assert.equal(steers, 0);
  } finally { finish.release(); await task; }
  await f.bridge.handle('!dm:test', event('!status', '$finished'));
  assert.match(f.replies.at(-1)!, /Task:.*Idle/);
});

test('!status respects room privacy and unsupported bots', async t => {
  let reads = 0;
  const f = fixture(t, 'codex', undefined, false, { status: () => { reads++; return 'private'; } });
  await f.bridge.handle('!dm:test', event('!status'));
  assert.equal(reads, 0);
  assert.deepEqual(f.replies, []);
  const manager = fixture(t, 'manager');
  await manager.bridge.handle('!dm:test', event('!status'));
  assert.match(manager.replies.at(-1)!, /not available/);
  assert.deepEqual(manager.calls, []);
});

for (const kind of ['codex', 'claude'] as const) for (const sender of ['@owner:test', '@guest:test']) test(`reviewed publication (${kind}, ${sender}) delivers HTML before enabling approval and never calls a model`, async t => {
  const uploadStarted = gate(), uploadFinish = gate(), confirmationStarted = gate();
  let published = false, calls = 0, steers = 0;
  const f = fixture(t, kind, async () => assert.fail('No model request'), true, {
    timeoutMs: 5000,
    isAuthorized: user => ['@owner:test', '@guest:test'].includes(user),
    publish: async (input, signal, interact, authorize) => {
      calls++;
      assert.deepEqual(input, { repository: '.', remote: 'origin', branch: 'main' });
      const answer = await interact({ text: 'Publish review?', attachments: [{ root: '/review', path: '/review/report.html' }], approve: { yes: true }, deny: { yes: false } }, signal);
      await authorize(); published = 'yes' in answer && answer.yes === true; return published ? 'Published.' : 'Declined.';
    },
    sendAttachments: async () => { uploadStarted.release(); await uploadFinish.promise; },
    confirmation: async (_room, _event, _text, controls) => { controls.bind('$publish-confirmation'); confirmationStarted.release(); },
    steer: async () => { steers++; return true; },
  });
  const incoming = (body: string, id: string) => ({ ...event(body, id), sender });
  const task = f.bridge.handle('!dm:test', incoming('!publish {"repository":".","remote":"origin","branch":"main"}', '$publish'));
  await uploadStarted.promise;
  try {
    await f.bridge.handle('!dm:test', incoming('!approve', '$early'));
    assert.match(f.replies.at(-1)!, /still being delivered/); assert.equal(published, false);
    await f.bridge.handle('!dm:test', incoming('change the request', '$steer'));
    assert.equal(steers, 0);
    uploadFinish.release(); await confirmationStarted.promise;
    await f.bridge.handle('!elsewhere:test', incoming('!approve', '$wrong-room'));
    assert.equal(published, false);
    const other = sender === '@owner:test' ? '@guest:test' : '@owner:test';
    await f.bridge.handle('!dm:test', { ...event('!approve', '$wrong-user'), sender: other });
    await f.bridge.handle('!dm:test', { ...reaction('$publish-confirmation', '✅', '$wrong-reaction'), sender: other });
    await f.bridge.handle('!dm:test', { ...incoming('!approve', '$wrong-thread'), content: { msgtype: 'm.text', body: '!approve', 'm.relates_to': { rel_type: 'm.thread', event_id: '$different' } } });
    assert.equal(published, false);
    await f.bridge.handle('!dm:test', incoming('!approve', '$approved'));
    await task;
    assert.equal(published, true); assert.equal(calls, 1);
    await f.bridge.handle('!dm:test', incoming('!approve', '$replay'));
    assert.equal(calls, 1);
  } finally { uploadFinish.release(); f.bridge.stop(); await task; }
});

for (const route of ['command', 'agent'] as const) for (const outcome of ['deny', 'revoke', 'privacy'] as const)
test(`guest publication via ${route} never pushes after ${outcome}`, async t => {
  const confirmation = gate(), decision = gate(), finish = gate();
  let allowed = true, privateRoom = true, pushed = false;
  const f = fixture(t, 'codex', async (_kind, _prompt, _key, signal, _sender, _files, _interact, publish) => {
    assert.ok(publish);
    return publish({ repository: '.', remote: 'origin', branch: 'main' }, signal);
  }, true, {
    timeoutMs: 5000,
    isAuthorized: user => user === '@guest:test' && allowed,
    isPrivateRoom: async () => privateRoom,
    confirmation: async () => { confirmation.release(); },
    publish: async (_input, signal, interact, authorize) => {
      const answer = await interact({ text: 'Publish?', approve: { approved: true }, deny: { approved: false } }, signal);
      decision.release();
      if (!('approved' in answer) || answer.approved !== true) return 'Declined.';
      await finish.promise;
      await authorize();
      pushed = true;
      return 'Published.';
    },
  });
  const incoming = (body: string, id: string) => ({ ...event(body, id), sender: '@guest:test' });
  const task = f.bridge.handle('!dm:test', incoming(route === 'command' ? '!publish {}' : 'Publish the project', '$start'));
  try {
    await confirmation.promise;
    await f.bridge.handle('!dm:test', incoming(outcome === 'deny' ? '!deny' : '!approve', '$answer'));
    await decision.promise;
    if (outcome === 'revoke') { allowed = false; f.bridge.revoke('@guest:test'); }
    if (outcome === 'privacy') privateRoom = false;
    finish.release();
    await task;
    assert.equal(pushed, false);
    if (outcome === 'deny') assert.equal(f.replies.at(-1), 'Declined.');
    else assert.equal(f.errors.length, 1);
  } finally { finish.release(); f.bridge.stop(); await task; }
});

test('reviewed publication rejects unauthorized callers, malformed requests, and failed report delivery', async t => {
  let calls = 0, confirmed = false;
  const f = fixture(t, 'codex', async () => assert.fail('No model'), true, {
    isAuthorized: user => user === '@owner:test',
    publish: async (_input, signal, interact) => {
      calls++; const answer = await interact({ text: 'Publish?', attachments: [{ root: '/review', path: '/review/report.html' }], approve: { yes: true }, deny: { yes: false } }, signal);
      confirmed = 'yes' in answer && answer.yes === true; return 'unexpected';
    },
    sendAttachments: async () => { throw new Error('Upload failed'); },
  });
  await f.bridge.handle('!dm:test', { ...event('!publish {}', '$guest'), sender: '@guest:test' });
  await f.bridge.handle('!dm:test', event('!publish invalid', '$invalid'));
  assert.equal(calls, 0);
  await f.bridge.handle('!dm:test', event('!publish {}', '$upload'));
  assert.equal(confirmed, false); assert.equal(calls, 1);
  await f.bridge.handle('!dm:test', event('!approve', '$late'));
  assert.match(f.replies.at(-1)!, /No pending confirmation/);
  assert.equal(confirmed, false);
});

test('compaction service hook uses the human identity, and delivery failure does not stop the task', async t => {
  const notices: unknown[] = [];
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, _signal, _sender, _files, _interact, _publish, hooks) => {
    await hooks!.compaction!('started');
    await hooks!.compaction!('completed');
    return 'answer';
  }, true, { compaction: async (phase, context) => {
    notices.push({ phase, context });
    if (phase === 'started') throw new Error('Delivery failed');
  } });
  await f.bridge.handle('!dm:test', event());
  assert.deepEqual(notices, ['started', 'completed'].map(phase => ({ phase, context: { room: '!dm:test', sender: '@owner:test' } })));
  assert.equal(f.errors.length, 1);
  assert.equal(f.replies.at(-1), 'answer');
});


for (const delivery of ['progress', 'attachment'] as const) test(`typing resumes immediately after ${delivery} delivery while the task is active`, async t => {
  const ready = gate(), finish = gate();
  let visible = false, serverTyping = false;
  const f = fixture(t, 'codex', async (_mode, _prompt, _key, _signal, _sender, _files, _interact, _publish, hooks) => {
    if (delivery === 'progress') await hooks!.progress!('Still working');
    else await hooks!.sendAttachments!([{ root: '/outbox', path: '/outbox/file.txt' }], new AbortController().signal);
    ready.release(); await finish.promise;
    return 'done';
  }, true, {
    typing: async (_room, typing) => {
      // Synapse renews the TTL without emitting m.typing if the value is unchanged.
      if (serverTyping !== typing) visible = typing;
      serverTyping = typing;
    },
    reply: async () => { visible = false; }, // Clients can clear typing when a message arrives.
    sendAttachments: async () => { visible = false; },
  });
  const task = f.bridge.handle('!dm:test', event());
  try {
    await ready.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(visible, true);
  } finally { finish.release(); await task; }
  assert.equal(visible, false);
});
