import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerDiagnosticError, errorMessage } from '../src/errors.js';
import { RpcError } from '../src/app-server.js';
import { sendOwnerDiagnostic } from '../src/owner-diagnostics.js';
import { isPrivateRoom } from '../src/private-room.js';
import { SERVICE } from '../src/bridge.js';

test('owner receives complete original text as plain service messages, including long Unicode diagnostics', async () => {
  const details = '<b>original</b> ' + 'Ошибка🙂'.repeat(20_000);
  const error = new OwnerDiagnosticError('Task failed.', details);
  const sent: any[] = [];
  await sendOwnerDiagnostic(error, '@owner:test', '@owner:test', '!home:test', {
    allowed: async () => true, stopping: () => false,
    send: async (room, content) => { assert.equal(room, '!home:test'); sent.push(content); },
  });
  assert.equal(sent.map(c => c.body).join(''), `Task failed.\n\nOriginal Codex diagnostic:\n${details}`);
  for (const c of sent) {
    assert.equal(c[SERVICE], true); assert.equal(c.formatted_body, undefined);
    assert.deepEqual(c['m.mentions'], {});
  }
  assert.equal(errorMessage(error), 'Task failed.');
  assert.ok(!JSON.stringify(error).includes('original'));
  const rpc = new RpcError(-32603, details, 'account/read');
  assert.equal(rpc.ownerDetails(), details);
  assert.ok(!errorMessage(rpc).includes('original'));
});

test('diagnostics require owner identity and a current encrypted two-person room', async () => {
  let extraMember = false, encrypted = true, authorized = true, stopping = false, sends = 0;
  const client = { getRoomState: async () => [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: encrypted ? 'm.megolm.v1.aes-sha2' : '' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...['@bot:test', '@owner:test', ...extraMember ? ['@peer:test'] : []].map(id =>
      ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } })),
  ] };
  const transport = {
    allowed: (room: string) => isPrivateRoom(client, room, '@bot:test', '@owner:test', () => authorized),
    stopping: () => stopping, send: async () => { sends++; },
  };
  const error = new OwnerDiagnosticError('Failed', 'full text');
  const send = () => sendOwnerDiagnostic(error, '@owner:test', '@owner:test', '!home:test', transport);
  await sendOwnerDiagnostic(error, '@guest:test', '@owner:test', '!home:test', transport);
  await sendOwnerDiagnostic(new Error('not a provider diagnostic'), '@owner:test', '@owner:test', '!home:test', transport);
  assert.equal(sends, 0);
  await send(); assert.equal(sends, 1);
  extraMember = true; await assert.rejects(send(), /withheld/);
  extraMember = false; encrypted = false; await assert.rejects(send(), /withheld/);
  encrypted = true; authorized = false; await assert.rejects(send(), /withheld/);
  authorized = true; stopping = true; await assert.rejects(send(), /withheld/);
  assert.equal(sends, 1);
});

test('multipart diagnostics recheck privacy and never automatically retry an uncertain send', async () => {
  const error = new OwnerDiagnosticError('Failed', 'x'.repeat(7000));
  let sent = 0;
  await assert.rejects(sendOwnerDiagnostic(error, 'owner', 'owner', 'home', {
    allowed: async () => sent === 0, stopping: () => false, send: async () => { sent++; },
  }), /withheld/);
  assert.equal(sent, 1);
  sent = 0;
  await assert.rejects(sendOwnerDiagnostic(error, 'owner', 'owner', 'home', {
    allowed: async () => true, stopping: () => false,
    send: async () => { sent++; throw new Error('uncertain'); },
  }), /uncertain/);
  assert.equal(sent, 1);
});
