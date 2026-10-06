import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactionNotices, sendCompactionNotice } from '../src/compaction-notices.js';
import { isPrivateRoom } from '../src/private-room.js';
import { SERVICE } from '../src/bridge.js';

test('compaction delivery is ordered, attempted once, and never masks task completion', async () => {
  const phases: string[] = [];
  const notices = compactionNotices(async phase => {
    await new Promise(resolve => setTimeout(resolve, 1));
    phases.push(phase);
    if (phase === 'started') throw new Error('Uncertain delivery');
  });
  notices.complete('history');
  notices.start('one'); notices.start('one'); notices.complete('one'); notices.complete('one'); notices.start('one');
  notices.start('two');
  await notices.close(); await notices.close();
  assert.deepEqual(phases, ['started', 'completed', 'started', 'unconfirmed']);
});

test('compaction service notices require a current encrypted two-person room', async () => {
  const sent: { room: string; content: any }[] = [];
  let permitted = true, stopping = false, extraMember = false, encrypted = true;
  const client = { getRoomState: async () => [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: encrypted ? 'm.megolm.v1.aes-sha2' : '' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...['@bot:test', '@owner:test', ...extraMember ? ['@peer:test'] : []].map(id =>
      ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } })),
  ] };
  const transport = {
    allowed: (room: string) => isPrivateRoom(client, room, '@bot:test', '@owner:test', () => permitted),
    stopping: () => stopping,
    send: async (room: string, content: any) => { sent.push({ room, content }); },
  };
  await sendCompactionNotice('started', '!home:test', transport);
  extraMember = true;
  await assert.rejects(sendCompactionNotice('completed', '!home:test', transport), /withheld/);
  extraMember = false; encrypted = false;
  await assert.rejects(sendCompactionNotice('completed', '!home:test', transport), /withheld/);
  encrypted = true; permitted = false;
  await assert.rejects(sendCompactionNotice('completed', '!home:test', transport), /withheld/);
  permitted = true; stopping = true;
  await assert.rejects(sendCompactionNotice('completed', '!home:test', transport), /withheld/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, '!home:test');
  assert.equal(sent[0].content.msgtype, 'm.notice');
  assert.equal(sent[0].content[SERVICE], true);
  assert.deepEqual(sent[0].content['m.mentions'], {});
  assert.equal(sent[0].content['m.relates_to'], undefined);
});
