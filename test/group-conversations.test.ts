import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationLinks, isSharedRoomState, PEER_CREDIT } from '../src/conversation-links.js';
import { GRANT, sessionKey, type MatrixEvent } from '../src/bridge.js';
import { State } from '../src/state.js';
import { linkedRoomMessages, roomMessageDelivery } from '../src/room-messages.js';

const owner = '@owner:test', bots = ['@one:test', '@two:test', '@three:test'];
const room = '!group:test';
const message = (sender = owner, id = '$human'): MatrixEvent => ({ type: 'm.room.message', sender,
  event_id: id, origin_server_ts: 1000, content: { msgtype: 'm.text', body: 'Hello' } });
const home = (bot: string) => '!home-' + bots.indexOf(bot) + ':test';
function fixture(t: { after(fn: () => void): void }, local = bots) {
  const dir = mkdtempSync(join(tmpdir(), 'group-conversations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(join(dir, 'sessions.json'));
  const accounts = local.map(userId => ({ userId, kind: 'claude' as const, name: userId, accessToken: 'test' }));
  const agents = local.map(bot => ({ bot, owner, home: home(bot), session: 'session-' + bots.indexOf(bot) }));
  for (const agent of agents) state.update(sessionKey(agent.home, message()), { claude: agent.session });
  const config = { version: 1, agents, rooms: [{ room, owner, bots }] };
  const path = join(dir, 'links.json'), history = join(dir, 'history.json');
  writeFileSync(path, JSON.stringify(config));
  const load = () => new ConversationLinks(path, history, accounts, state, owner);
  return { dir, path, history, state, config, load, links: load() };
}
function roomState() {
  return [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...[owner, ...bots].map(state_key => ({ type: 'm.room.member', state_key, content: { membership: 'join' } })),
  ];
}
function outgoing(links: ConversationLinks, sender: string, to: string[], id = '$peer'): MatrixEvent {
  return JSON.parse(JSON.stringify({ ...message(sender, id),
    content: links.outgoing(sender, room, { msgtype: 'm.text', body: 'Please review' }, to) }));
}
function admit(links: ConversationLinks, recipient: string, event: MatrixEvent) {
  links.observe(recipient, room, event);
  return links.mention(recipient, room, event);
}

test('three agents retain separate sessions and exact room membership', async t => {
  const f = fixture(t);
  for (const bot of bots) {
    assert.equal(f.links.key(bot, room, message()), sessionKey(home(bot), message()));
    assert.equal(await f.links.allowed(bot, room, owner, async () => roomState()), true);
    assert.equal(f.links.addressed(bot, room, message()), true);
    const targeted = { ...message(), content: { ...message().content, 'm.mentions': { user_ids: [bots[2]] } } };
    assert.equal(f.links.addressed(bot, room, targeted), bot === bots[2]);
    const context = JSON.parse(f.links.prompt(bot, room, message(), 'Hello').split('\n')[1]);
    assert.deepEqual(context.participants, [owner, ...bots]);
  }
  for (const membership of ['invite', 'knock', 'leave']) {
    const state = roomState();
    state.at(-1)!.content = { membership };
    assert.equal(isSharedRoomState(state, [owner, ...bots]), false);
  }
  assert.equal(isSharedRoomState([...roomState(), { type: 'm.room.member', state_key: '@extra:test', content: { membership: 'invite' } }], [owner, ...bots]), false);
  for (const invalid of [[bots[0]], [bots[0], bots[1], bots[1]], [bots[0], bots[1], owner]]) {
    writeFileSync(f.path, JSON.stringify({ ...f.config, rooms: [{ room, owner, bots: invalid }] }));
    assert.throws(f.load, /distinct agents/);
  }
  writeFileSync(f.path, JSON.stringify({ ...f.config, agents: f.config.agents.slice(0, 2) }));
  assert.throws(f.load, /explicit session link/);
});

test('shared observations remain available until the third agent has read them', t => {
  const f = fixture(t), incoming = message(owner, '$history');
  f.links.observe(bots[0], room, incoming);
  const logged = () => JSON.parse(readFileSync(f.history, 'utf8'))[room].messages.map((m: { id: string }) => m.id);
  for (const [i, bot] of bots.entries()) {
    const prompt = f.links.prompt(bot, home(bot), message(owner, '$private-' + bot), 'Continue');
    assert.match(prompt, /\$history/);
    f.links.acknowledge(bot);
    if (i < bots.length - 1) assert.deepEqual(logged(), ['$history']);
  }
  assert.deepEqual(JSON.parse(readFileSync(f.history, 'utf8'))[room].messages, []);
});

test('a single mention selects the third agent instead of the first peer', t => {
  const f = fixture(t);
  f.links.credit(bots[0]);
  const event = outgoing(f.links, bots[0], [bots[2]]);
  assert.equal((event.content![GRANT] as any).to, bots[2]);
  assert.equal(admit(f.links, bots[1], event), undefined);
  assert.ok(admit(f.links, bots[2], event));
  assert.equal(f.links.peerCredit(bots[0]), PEER_CREDIT - 1);
});

test('multiple recipients each receive a paid grant once, even across restarts', t => {
  const f = fixture(t);
  f.links.credit(bots[0]);
  const event = outgoing(f.links, bots[0], [bots[1], bots[2], bots[1]]);
  assert.deepEqual(event.content!['m.mentions']!.user_ids, [bots[1], bots[2]]);
  assert.deepEqual((event.content![GRANT] as any[]).map(g => g.remaining), [PEER_CREDIT - 2, PEER_CREDIT - 2]);
  assert.equal(f.links.peerCredit(bots[0]), PEER_CREDIT - 2);
  let links = f.load();
  for (const recipient of [bots[2], bots[1]]) {
    assert.ok(admit(links, recipient, event));
    links = f.load();
    assert.equal(admit(links, recipient, event), undefined);
    assert.equal(admit(links, recipient, { ...event, event_id: '$replay-' + recipient }), undefined);
    assert.equal(links.peerCredit(recipient), PEER_CREDIT - 2);
  }
});

test('recipient sets are validated before spending any credit', t => {
  const f = fixture(t);
  f.links.credit(bots[0]);
  for (const recipients of [[bots[0]], ['@outsider:test'], [bots[1], '@outsider:test']]) {
    assert.equal(f.links.reserveMentions(bots[0], room, recipients), undefined);
    assert.equal(f.links.peerCredit(bots[0]), PEER_CREDIT);
    const result = f.links.mentions(bots[0], room, 'Hi\n```matrix-mentions\n' + JSON.stringify({ to: recipients }) + '\n```');
    assert.ok(result?.error);
  }
  for (let i = 0; i < PEER_CREDIT - 1; i++) f.links.reserveMentions(bots[0], room, [bots[1]]);
  assert.equal(f.links.reserveMentions(bots[0], room, [bots[1], bots[2]]), undefined);
  assert.equal(f.links.peerCredit(bots[0]), 1);
  assert.ok(f.links.mentions(bots[0], room, 'Hi\n```matrix-mentions\n' + JSON.stringify({ to: [bots[1], bots[2]] }) + '\n```')?.error);
  assert.equal(outgoing(f.links, bots[0], [bots[1], bots[2]]).content![GRANT], undefined);
});

test('multi-recipient grants work between separate installations without replay or misdelivery', t => {
  const instances = bots.map(bot => fixture(t, [bot]));
  instances[0].links.credit(bots[0]);
  const event = outgoing(instances[0].links, bots[0], bots.slice(1));
  for (const i of [2, 1]) {
    assert.ok(admit(instances[i].links, bots[i], event));
    const reloaded = instances[i].load();
    assert.equal(admit(reloaded, bots[i], { ...event, event_id: '$copy' }), undefined);
    assert.equal(reloaded.peerCredit(bots[i]), PEER_CREDIT - 2);
  }
  const other = outgoing(instances[0].links, bots[0], [bots[2]], '$other');
  other.content!['m.mentions'] = { user_ids: [bots[1]] };
  assert.equal(admit(instances[1].links, bots[1], other), undefined);
});

test('a three-agent mention cycle exhausts its credit without new human messages', t => {
  const f = fixture(t);
  for (const bot of bots) f.links.credit(bot);
  let messages = 0;
  while (bots.some(bot => f.links.peerCredit(bot))) {
    assert.ok(messages < 200, 'mention cycle must terminate');
    for (const [i, bot] of bots.entries()) {
      if (!f.links.peerCredit(bot)) continue;
      const peers = [bots[(i + 1) % 3], bots[(i + 2) % 3]].slice(0, Math.min(2, f.links.peerCredit(bot)));
      const event = outgoing(f.links, bot, peers, '$cycle-' + messages++);
      for (const peer of peers) assert.ok(admit(f.links, peer, event));
    }
  }
  assert.ok(messages > 3);
});

test('room tool lists agents and requires explicit recipients for group mentions', async t => {
  const f = fixture(t), sent: any[] = [], signal = new AbortController().signal;
  const action = roomMessageDelivery(linkedRoomMessages(f.links, bots[0], {
    event: message(), key: sessionKey(home(bots[0]), message()),
  }, { allowed: async () => true, stopping: () => false, send: async (_room, content) => { sent.push(content); return '$sent'; } }));
  const listed = JSON.parse(await action({ action: 'list' }, signal));
  assert.deepEqual(listed.rooms[0], { room, type: 'shared', agents: bots });
  f.links.credit(bots[0]);
  await assert.rejects(action({ action: 'send', room, text: 'Hi', id: 'ambiguous', mention: true }, signal), /Select recipients/);
  await assert.rejects(action({ action: 'send', room, text: 'Hi', id: 'outsider', mentions: ['@outsider:test'] }, signal), /Only other agents/);
  assert.equal(f.links.peerCredit(bots[0]), PEER_CREDIT);
  const request = { action: 'send', room, text: 'Hi', id: 'targeted', mentions: [bots[2], bots[1]] };
  await action(request, signal);
  await action(request, signal);
  assert.equal(sent.length, 1);
  for (const bot of bots.slice(1)) assert.ok(admit(f.links, bot, { ...message(bots[0], '$sent'), content: sent[0] }));
  assert.equal(f.links.peerCredit(bots[0]), PEER_CREDIT - 2);
});


test('larger groups are allowed while a single wake remains bounded by credit', t => {
  const f = fixture(t, [bots[0]]), peers = Array.from({ length: 7 }, (_, i) => `@remote${i}:test`);
  writeFileSync(f.path, JSON.stringify({ ...f.config, rooms: [{ room, owner, bots: [bots[0], ...peers] }] }));
  const links = f.load();
  links.credit(bots[0]);
  assert.equal(links.room(bots[0], room)!.bots.length, 8);
  assert.equal(links.reserveMentions(bots[0], room, peers), undefined);
  assert.equal(links.peerCredit(bots[0]), PEER_CREDIT);
  assert.equal(links.reserveMentions(bots[0], room, peers.slice(0, PEER_CREDIT))!.length, PEER_CREDIT);
  assert.equal(links.peerCredit(bots[0]), 0);
});

test('ambiguous and oversized grant arrays cannot start a recipient', t => {
  const f = fixture(t);
  f.links.credit(bots[0]);
  const original = outgoing(f.links, bots[0], [bots[1], bots[2]]);
  const wires = original.content![GRANT] as any[];
  for (const [i, invalid] of [[wires[0], wires[0]], Array(PEER_CREDIT + 1).fill(wires[0])].entries()) {
    const event = { ...original, event_id: '$invalid-' + i, content: { ...original.content, [GRANT]: invalid } };
    assert.equal(admit(f.links, bots[1], event), undefined);
  }
  assert.ok(admit(f.links, bots[1], original));
  assert.ok(admit(f.links, bots[2], original));
});
