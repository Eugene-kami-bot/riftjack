import { routingInstructions } from '../src/routing-instructions.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationLinks, isSharedRoomState, MENTION_REPLY_LIMIT, mentionText, PEER_CREDIT } from '../src/conversation-links.js';
import { replyContent } from '../src/message-format.js';
import { State } from '../src/state.js';
import { linkedRoomMessages } from '../src/room-messages.js';
import { AGENT_TRIGGER, Bridge, GRANT, NOTICE, REPLY, SERVICE, sessionKey, type MatrixEvent } from '../src/bridge.js';

const human = '@alice:test', bot = '@builder:test', peer = '@reviewer:test';
const home = '!home:test', group = '!group:test';
const message = (body: string, id = '$1', sender = human): MatrixEvent => ({ type: 'm.room.message',
  sender, event_id: id, origin_server_ts: 2000, content: { msgtype: 'm.text', body } });
const canonical = sessionKey(home, message(''));

test('ordinary routing carries only current context and omits unchanged rules and empty observations', t => {
  const f = fixture(t);
  for (const steering of [false, true]) {
    const prompt = f.links.prompt(bot, home, message('Hello'), 'Hello', steering);
    const context = JSON.parse(prompt.split('\n')[1]);
    assert.deepEqual(context, { room: home, visibility: 'private', human, author: human, trigger: 'human-message' });
    assert.ok(prompt.endsWith('Current human message:\nHello'));
    assert.doesNotMatch(prompt, /Matrix routing rules|matrix-mentions|unreadSharedMessages|remainingMessages/);
    assert.ok(prompt.length < 300);
  }
  // A shared turn in the same session is explicit, even after a private turn or compaction.
  const shared = JSON.parse(f.links.prompt(bot, group, message('Hello'), 'Hello').split('\n')[1]);
  assert.equal(shared.visibility, 'shared');
  assert.equal(shared.room, group);
  assert.deepEqual(shared.participants, [human, bot, peer]);
  assert.equal(shared.peerCredit, 0);
});

test('already-delivered status survives pruning and restart and distinguishes observations from quotes', t => {
  for (const quoted of [false, true]) {
    const f = pair(t); let links = f.links;
    links.credit(peer);
    const question = paid(links, 'Review question', '$review-question', peer, [bot]);
    links.observe(bot, group, question);
    const notice = links.mention(bot, group, question)!;
    const earlier = quoted ? notice : message('Human turn', '$human-turn');
    links.prompt(bot, group, earlier, earlier.content!.body!); links.acknowledge(bot);
    links.prompt(peer, group, message('Peer turn', '$peer-turn'), 'Peer turn'); links.acknowledge(peer);
    links = f.load();
    const context = JSON.parse(links.prompt(bot, group, notice, notice.content!.body!).split('\n')[1]);
    assert.equal(context.alreadyDelivered, quoted ? undefined : true);
  }
});

test('a partially delivered question is not already delivered', t => {
  const f = pair(t), links = f.links;
  links.credit(peer);
  const question = paid(links, 'Review question ' + 'x'.repeat(16000), '$review-long', peer, [bot]);
  links.observe(bot, group, question);
  const notice = links.mention(bot, group, question)!;
  const first = JSON.parse(links.prompt(bot, group, message('First', '$first'), 'First').split('\n')[1]);
  assert.equal(first.unreadSharedMessages[0].continues, true);
  links.acknowledge(bot);
  const partial = JSON.parse(links.prompt(bot, group, notice, notice.content!.body!).split('\n')[1]);
  assert.equal(partial.alreadyDelivered, undefined);
  links.prompt(bot, group, message('Second', '$second'), 'Second'); links.acknowledge(bot);
  const full = JSON.parse(links.prompt(bot, group, notice, notice.content!.body!).split('\n')[1]);
  assert.equal(full.alreadyDelivered, true);
});

test('outbound room messages enforce destination privacy and session binding without copying source metadata', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  let live = roomState(), stopping = false, calls = 0, resetDuringCheck = false;
  const event = message('Private instruction');
  Object.assign(event.content!, { 'm.relates_to': { rel_type: 'm.thread', event_id: '$private' }, 'm.mentions': { user_ids: [peer] } });
  const action = linkedRoomMessages(f.links, bot, { event, key: canonical }, {
    stopping: () => stopping,
    allowed: async (room, sender) => {
      if (resetDuringCheck) f.state.reset(canonical);
      return f.links.allowed(bot, room, sender, async () => live);
    },
    send: async (room, content) => {
      calls++;
      assert.equal(room, group);
      assert.deepEqual(content, { msgtype: 'm.text', body: 'Public result.', 'm.mentions': { user_ids: [] } });
      return '$sent';
    },
  });
  assert.deepEqual(JSON.parse(await action({ action: 'list' }, signal)), { rooms: [{ room: group, type: 'shared' }] });
  const send = (room = group) => action({ action: 'send', room, text: 'Public result.', id: 'one' }, signal);
  assert.equal(JSON.parse(await send()).event_id, '$sent');
  for (const room of [home, '!unlisted:test']) await assert.rejects(send(room));
  for (const membership of ['join', 'invite', 'knock']) {
    live = [...roomState(), { type: 'm.room.member', state_key: '@extra:test', content: { membership } }];
    await assert.rejects(send());
    assert.deepEqual(JSON.parse(await action({ action: 'list' }, signal)), { rooms: [] });
  }
  live = roomState(); Object.assign(live[2].content, { history_visibility: 'shared' });
  await assert.rejects(send());
  live = roomState(); stopping = true; await assert.rejects(send());
  stopping = false; resetDuringCheck = true; await assert.rejects(send());
  assert.equal(calls, 1);
});

test('an agent can return a result to its own private chat, but not mention anyone there', async t => {
  const f = fixture(t), signal = new AbortController().signal, sent: [string, object][] = [];
  const privateState = roomState().filter(e => e.state_key !== peer);
  let homePrivate = true;
  const action = linkedRoomMessages(f.links, bot, { event: message('Ask the reviewer'), key: canonical }, {
    stopping: () => false,
    allowed: (room, sender) => f.links.allowed(bot, room, sender, async () => room === home ? (homePrivate ? privateState : roomState()) : roomState()),
    send: async (room, content) => { sent.push([room, content]); return '$sent'; },
  });
  assert.deepEqual(JSON.parse(await action({ action: 'list' }, signal)).rooms, [{ room: group, type: 'shared' }, { room: home, type: 'private' }]);
  await action({ action: 'send', room: home, text: 'The reviewer found nothing.', id: 'result' }, signal);
  assert.deepEqual(sent, [[home, { msgtype: 'm.text', body: 'The reviewer found nothing.', 'm.mentions': { user_ids: [] } }]]);
  f.links.credit(bot);
  await assert.rejects(action({ action: 'send', room: home, text: 'Wake?', id: 'wake', mention: true }, signal), /only for the other agent/);
  // A private chat that gained another member is no longer a destination.
  homePrivate = false;
  await assert.rejects(action({ action: 'send', room: home, text: 'Leak?', id: 'leak' }, signal), /withheld/);
  assert.equal(sent.length, 1);
});

test('an outbound room message can mention the peer only with peer credit', async t => {
  const f = fixture(t), signal = new AbortController().signal, sent: object[] = [];
  const action = linkedRoomMessages(f.links, bot, { event: message('Tell the reviewer'), key: canonical }, {
    stopping: () => false, allowed: async (room, sender) => f.links.allowed(bot, room, sender, async () => roomState()),
    send: async (_room, content) => { sent.push(content); return '$sent'; },
  });
  const send = (id: string) => action({ action: 'send', room: group, text: 'Please review.', id, mention: true }, signal);
  await assert.rejects(send('no-credit'), /no peer credit/);
  f.links.credit(bot);
  await send('paid');
  // The credit is spent as the message is prepared; the grant travels with it.
  assert.equal(f.links.peerCredit(bot), PEER_CREDIT - 1);
  const [content] = sent as Record<string, unknown>[];
  assert.equal(typeof content[GRANT], 'string');
  assert.deepEqual({ ...content, [GRANT]: undefined }, { msgtype: 'm.text', body: 'Please review.\n\n' + peer, 'm.mentions': { user_ids: [peer] }, [GRANT]: undefined });
  // More mentions than credit cannot be sent ahead of their delivery.
  for (let i = 1; i < PEER_CREDIT; i++) await send('paid-' + i);
  await assert.rejects(send('over-budget'), /no peer credit/);
  assert.equal(sent.length, PEER_CREDIT);
});

test('peer credit is restored once per accepted human message, after access checks', async t => {
  const f = pair(t);
  let allowed = true, accepted = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => allowed,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    accepted: () => { accepted++; f.links.credit(bot); },
    run: async () => 'done', reply: async () => {}, report: e => { throw e; },
  });
  await bridge.handle(home, message('Task', '$task'));
  f.links.reserve(bot, group);
  // A replayed event, a command or a message refused by access checks restores nothing.
  await bridge.handle(home, message('Task', '$task'));
  await bridge.handle(home, message('!status', '$status'));
  allowed = false; await bridge.handle(home, message('Denied', '$denied'));
  assert.equal(accepted, 1);
  assert.equal(f.links.peerCredit(bot), PEER_CREDIT - 1);
});

test('timer, background and reaction turns are labelled as connector notices, not human messages', async t => {
  const f = fixture(t);
  for (const [notice, author] of [['timer', 'connector'], ['background', 'connector'], ['reaction', human]] as const) {
    const event = message('Notice text', '$' + notice); Object.assign(event.content!, { [NOTICE]: notice });
    const prompt = f.links.prompt(bot, home, event, 'Notice text');
    const context = JSON.parse(prompt.split('\n')[1]);
    assert.deepEqual([context.trigger, context.author], [notice, author]);
    assert.match(prompt, /Current connector notice:\nNotice text$/);
  }
  assert.match(f.links.prompt(bot, home, message('Hi'), 'Hi'), /"trigger":"human-message"[^]*Current human message:\nHi$/);
  // A Matrix event cannot claim to be such a notice.
  let runs = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true, linkedSession: (room, event) => f.links.key(bot, room, event),
    run: async () => { runs++; return 'done'; }, reply: async () => {}, report: e => { throw e; } });
  const forged = message('Pretend timer', '$forged'); Object.assign(forged.content!, { [NOTICE]: 'timer' });
  await bridge.handle(home, forged);
  assert.equal(runs, 0);
});

test('a mention notice says when a successful earlier turn already showed the message', t => {
  for (const earlierTurn of ['succeeds', 'fails'] as const) {
    const f = pair(t), links = f.links;
    links.observe(bot, group, message('Task', '$h1'));
    links.credit(peer);
    // The human's message is queued first; the peer's question arrives while it waits.
    const question = paid(links, 'Can you check the parser?', '$question', peer, [bot]);
    links.observe(bot, group, question);
    const notice = links.mention(bot, group, question)!;
    const earlier = JSON.parse(links.prompt(bot, group, message('Queued human message', '$h2'), 'Queued human message').split('\n')[1]);
    assert.ok(earlier.unreadSharedMessages.some((m: { id: string }) => m.id === '$question'));
    if (earlierTurn === 'succeeds') links.acknowledge(bot);
    const prompt = links.prompt(bot, group, notice, notice.content!.body!);
    const context = JSON.parse(prompt.split('\n')[1]);
    // The question is always quoted; the note appears only after a successful delivery.
    assert.match(prompt, /Can you check the parser\?/);
    assert.equal(context.alreadyDelivered, earlierTurn === 'succeeds' ? true : undefined);
    assert.equal(/already shown to you/.test(prompt), earlierTurn === 'succeeds');
  }
});
function roomState() {
  return [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ...[human, bot, peer].map(id => ({ type: 'm.room.member', state_key: id, content: { membership: 'join' } })),
  ];
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'linked-conversations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json'), state = new State(file);
  state.update(canonical, { codex: 'original-thread' });
  const config = { version: 1, agents: [{ bot, owner: human, home, session: 'original-thread' }],
    rooms: [{ room: group, owner: human, bots: [bot, peer] }] };
  const path = join(dir, 'links.json'), history = join(dir, 'history.json');
  const load = () => new ConversationLinks(path, history,
    [{ userId: bot, kind: 'codex', name: 'Builder', accessToken: 'test' }], state, human);
  writeFileSync(path, JSON.stringify(config));
  return { dir, file, path, state, config, load, links: load() };
}

test('shared rooms require encryption, restrictive history and exactly the configured participants', () => {
  assert.equal(isSharedRoomState(roomState(), [human, bot, peer]), true);
  for (const membership of ['join', 'invite', 'knock']) {
    const state = roomState();
    state.push({ type: 'm.room.member', state_key: '@extra:test', content: { membership } });
    assert.equal(isSharedRoomState(state, [human, bot, peer]), false);
  }
  const sharedHistory = roomState(); Object.assign(sharedHistory[2].content, { history_visibility: 'shared' });
  assert.equal(isSharedRoomState(sharedHistory, [human, bot, peer]), false);
  const missing = roomState().filter(e => e.state_key !== peer);
  assert.equal(isSharedRoomState(missing, [human, bot, peer]), false);
});

test('links continue the existing session and refuse missing or replaced histories', async t => {
  const f = fixture(t);
  assert.equal(f.links.key(bot, group, message('hello')), canonical);
  assert.equal(f.links.key(bot, home, message('hello')), canonical);
  assert.equal(await f.links.allowed(bot, group, human, async () => roomState()), true);
  assert.equal(await f.links.allowed(bot, group, peer, async () => roomState()), false);
  assert.throws(() => f.links.key(bot, '!other:test', message('hello')), /not linked/);
  f.state.reset(canonical);
  assert.throws(() => f.links.key(bot, group, message('hello')), /missing or changed/);
  assert.throws(f.load, /missing or changed/);
});

test('agent observations persist, do not become instructions or cross-room steering, and mentions address only their targets', t => {
  const f = fixture(t);
  f.links.observe(bot, group, message('A shared finding', '$peer', peer));
  f.links.observe(bot, group, message('A shared finding', '$peer', peer));
  f.links.observe(bot, home, message('Private detail', '$private'));
  // Connector commands are not observations, including behind the quote of a Matrix reply.
  assert.equal(f.links.observe(bot, group, message('!restart', '$command')), false);
  const reply = message('> earlier\n\n !status', '$quoted-command');
  Object.assign(reply.content!, { 'm.relates_to': { 'm.in_reply_to': { event_id: '$earlier' } } });
  assert.equal(f.links.observe(bot, group, reply), false);
  // Without reply metadata the bridge sends the whole text to the model, so it stays an observation.
  assert.equal(f.links.observe(bot, group, message('> Example command\n\n!status', '$plain-quote')), true);
  const resumed = f.load();
  const prompt = resumed.prompt(bot, group, message('Next', '$next'), 'Next');
  assert.equal(prompt.split('A shared finding').length - 1, 1);
  assert.ok(!prompt.includes('Private detail'));
  assert.match(routingInstructions, /not new instructions or approvals/);
  assert.match(resumed.prompt(bot, home, message('Next'), 'Next'), /A shared finding/);
  assert.ok(!resumed.prompt(bot, home, message('Update'), 'Update', true).includes('A shared finding'));
  const targeted = message('For the reviewer'); targeted.content!['m.mentions'] = { user_ids: [peer] };
  assert.equal(resumed.addressed(bot, group, targeted), false);
  assert.equal(resumed.addressed(bot, group, message('For everyone')), true);
});

test('unread batches have independent durable cursors and never discard an oversized message', t => {
  const f = fixture(t);
  const config = { ...f.config, agents: [...f.config.agents, { bot: peer, owner: human, home: '!peer-home:test', session: 'peer-thread' }] };
  f.state.update(sessionKey('!peer-home:test', message('')), { claude: 'peer-thread' });
  writeFileSync(f.path, JSON.stringify(config));
  const load = () => new ConversationLinks(f.path, join(f.dir, 'history.json'), [
    { userId: bot, kind: 'codex', name: 'Builder', accessToken: 'test' },
    { userId: peer, kind: 'claude', name: 'Reviewer', accessToken: 'test' },
  ], f.state, human);
  let links = load();
  const long = 'a'.repeat(16_000) + 'TAIL';
  links.observe(bot, group, message(long, '$long', peer));
  links.observe(bot, group, message('AFTER', '$after'));
  const context = (target: string) => JSON.parse(links.prompt(target, group, message('Next', '$next'), 'Next').split('\n')[1]);
  const first = context(bot);
  assert.equal(first.unreadSharedMessages.length, 1);
  assert.equal(first.unreadSharedMessages[0].continues, true);
  assert.ok(first.remainingMessages > 0);
  // No acknowledge means a failed turn can see the same observations again.
  assert.deepEqual(context(bot), first);
  links.acknowledge(bot); links = load();
  const rest = context(bot);
  assert.equal(first.unreadSharedMessages[0].body + rest.unreadSharedMessages[0].body, long);
  assert.equal(rest.unreadSharedMessages[1].body, 'AFTER');
  links.acknowledge(bot);
  assert.equal(context(bot).unreadSharedMessages, undefined);
  assert.equal(context(peer).unreadSharedMessages[0].offset, 0);
  links.acknowledge(peer);
  context(peer); links.acknowledge(peer);
  // Duplicate Matrix delivery after pruning cannot resurrect an old observation.
  links.observe(bot, group, message(long, '$long', peer));
  assert.equal(context(bot).unreadSharedMessages, undefined);
});

test('pending human messages are batched by conversation without consuming the next room or overflow', t => {
  const f = fixture(t);
  for (const [room, text, id] of [[group, 'First', '$a'], [group, 'Second', '$b'], [home, 'Private', '$c']]) {
    f.state.enqueue(bot, { room, event: message(text, id), feedback: false });
  }
  assert.deepEqual(f.state.dequeueBatch(bot).map(m => m.event.content!.body), ['First', 'Second']);
  assert.equal(f.state.queued(bot), 1);
  f.state.dequeueBatch(bot);
  f.state.enqueue(bot, { room: group, event: message('x'.repeat(10_000), '$d'), feedback: false });
  f.state.enqueue(bot, { room: group, event: message('y'.repeat(10_000), '$e'), feedback: false });
  assert.equal(f.state.dequeueBatch(bot).length, 1);
  assert.equal(f.state.queued(bot), 1);
});

function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
const tick = () => new Promise<void>(r => setImmediate(r));

test('another room queues a separate turn, never steers, and retains reply and approval scope', async t => {
  const f = fixture(t), started = gate(), finish = gate();
  const calls: string[] = [], replies: [string, string][] = [], errors: unknown[] = [];
  let steers = 0, running = 0, peak = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    steer: async () => { steers++; return true; }, report: e => errors.push(e),
    reply: async (room, _event, text) => { replies.push([room, text]); },
    run: async (_kind, prompt, key, _signal, _sender, _files, _interact, _publish, hooks) => {
      assert.equal(key, canonical); running++; peak = Math.max(peak, running); calls.push(prompt);
      if (prompt === 'First') { started.release(); await finish.promise; }
      await hooks!.progress!('progress ' + prompt); running--; return 'answer ' + prompt;
    },
  });
  const task = bridge.handle(home, message('First', '$first')); await started.promise;
  await bridge.handle(group, message('Second', '$second'));
  await bridge.handle(group, message('!approve', '$bad-approve'));
  assert.equal(steers, 0); assert.deepEqual(calls, ['First']); assert.equal(f.state.queued(bot), 1);
  assert.ok(replies.some(([room, text]) => room === group && /No pending confirmation/.test(text)));
  finish.release(); await task;
  while (bridge.busy) await tick();
  assert.deepEqual(calls, ['First', 'Second']); assert.equal(peak, 1); assert.deepEqual(errors, []);
  assert.ok(replies.some(([room, text]) => room === home && text === 'progress First'));
  assert.ok(replies.some(([room, text]) => room === group && text === 'progress Second'));
  assert.ok(replies.some(([room, text]) => room === group && text === 'answer Second'));
});

test('queued messages survive restart, recheck access and do not reset a pinned session', async t => {
  const f = fixture(t);
  f.state.enqueue(bot, { room: group, event: message('Saved', '$saved'), feedback: false });
  const state = new State(f.file), calls: string[] = [];
  let allowed = true;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state, since: 3000, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => allowed,
    linkedSession: () => canonical, run: async (_kind, prompt) => { calls.push(prompt); return 'done'; },
    reply: async () => {}, report: error => { throw error; },
  });
  await bridge.drainQueued(); assert.deepEqual(calls, ['Saved']);
  state.enqueue(bot, { room: group, event: message('Revoked', '$revoked'), feedback: false });
  allowed = false; await bridge.drainQueued(); assert.deepEqual(calls, ['Saved']);
  allowed = true;
  await bridge.handle(home, { ...message('!reset', '$reset'), origin_server_ts: 4000 });
  assert.equal(state.session(canonical).codex, 'original-thread');
});

test('each bot independently consumes the same shared Matrix event', async t => {
  const f = fixture(t), calls: string[] = [];
  for (const id of [bot, peer]) {
    const b = new Bridge({ botId: id, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 1000,
      isAuthorized: sender => sender === human, isPrivateRoom: async () => true,
      run: async () => { calls.push(id); return 'done'; }, reply: async () => {}, report: e => { throw e; } });
    await b.handle(group, message('Both', '$same'));
    await b.handle(group, message('Both', '$same'));
  }
  assert.deepEqual(calls, [bot, peer]);
});

test('a linked session does not allow a permission to cross its original room or human', async t => {
  const f = fixture(t), delivered = gate();
  let result: object | undefined, requestId = '';
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    run: async (_kind, _prompt, _key, signal, _sender, _files, interact) => {
      result = await interact!({ text: 'Test operation', approve: { allowed: true }, deny: { allowed: false } }, signal);
      return 'finished';
    },
    confirmation: async (room, _event, text, controls) => {
      assert.equal(room, home); requestId = /Confirmation ([a-f0-9]{12})/.exec(text)![1];
      controls.bind('$confirmation'); delivered.release();
    }, reply: async () => {}, report: e => { throw e; },
  });
  const task = bridge.handle(home, message('Do work', '$work')); await delivered.promise;
  await bridge.handle(group, message('!approve ' + requestId, '$wrong-room'));
  await bridge.handle(home, message('!approve ' + requestId, '$wrong-sender', peer));
  await bridge.handle(group, { ...message('', '$wrong-reaction'), type: 'm.reaction',
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$confirmation', key: '✅' } } });
  assert.equal(result, undefined);
  await bridge.handle(home, message('!approve ' + requestId, '$right-room')); await task;
  assert.deepEqual(result, { allowed: true });
});

test('linked background notifications use the saved session and keep their original delivery room', async t => {
  const f = fixture(t), replies: string[] = [], calls: string[] = [];
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    run: async (_kind, prompt, key) => { assert.equal(key, canonical); calls.push(prompt); return 'report'; },
    reply: async room => { replies.push(room); }, report: e => { throw e; },
  });
  let admissions = 0;
  assert.equal(await bridge.resumeBackground(group, message('Completed', '$watch'), 'original-thread', () => admissions++), true);
  assert.equal(admissions, 1); assert.deepEqual(calls, ['Completed']); assert.deepEqual(replies, [group]);
  assert.equal(await bridge.resumeBackground(group, message('Old', '$old'), 'replaced-thread', () => admissions++), false);
  assert.equal(admissions, 1);
});

test('slow room authorization cannot reorder incoming linked-room messages', async t => {
  const f = fixture(t), check = gate(), entered = gate(), running = gate(), finish = gate();
  const calls: string[] = [];
  let checks = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => {
      if (++checks === 1) { entered.release(); await check.promise; } return true;
    }, linkedSession: () => canonical,
    run: async (_kind, prompt) => { calls.push(prompt); if (prompt === 'First') { running.release(); await finish.promise; } return 'done'; },
    reply: async () => {}, report: e => { throw e; },
  });
  const first = bridge.handle(home, message('First', '$first')); await entered.promise;
  const second = bridge.handle(group, message('Second', '$second'));
  await tick(); assert.equal(checks, 1);
  check.release(); await running.promise; await second;
  assert.deepEqual(calls, ['First']); finish.release(); await first;
  while (bridge.busy) await tick();
  assert.deepEqual(calls, ['First', 'Second']);
});

function pair(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const config = { ...f.config, agents: [...f.config.agents, { bot: peer, owner: human, home: '!peer-home:test', session: 'peer-thread' }] };
  f.state.update(sessionKey('!peer-home:test', message('')), { claude: 'peer-thread' });
  writeFileSync(f.path, JSON.stringify(config));
  const load = () => new ConversationLinks(f.path, join(f.dir, 'history.json'), [
    { userId: bot, kind: 'codex', name: 'Builder', accessToken: 'test' },
    { userId: peer, kind: 'claude', name: 'Reviewer', accessToken: 'test' },
  ], f.state, human);
  return { ...f, load, links: load() };
}
const mentioning = (body: string, id: string, sender: string, to: string[]): MatrixEvent => {
  const event = message(body, id, sender);
  Object.assign(event.content!, { 'm.mentions': { user_ids: to } });
  return event;
};
// A mention paid with the sender's credit when it is prepared, as the connector does.
const paid = (links: ConversationLinks, body: string, id: string, sender: string, to: string[]): MatrixEvent => {
  const event = mentioning(body, id, sender, to), grant = links.reserve(sender, group);
  if (grant) Object.assign(event.content!, { [GRANT]: grant });
  return event;
};

test('explicit peer mentions start a durable connector notice paid with peer credit', t => {
  const f = pair(t);
  let links = f.links;
  assert.equal(links.observe(bot, group, message('Task', '$h1')), true);
  assert.equal(links.observe(bot, group, message('Task', '$h1')), false);
  // Without a human message to the sender, there is no credit to start its peer.
  assert.equal(links.mention(bot, group, mentioning('Unpaid', '$p0', peer, [bot])), undefined);
  links.credit(peer);
  assert.equal(links.mention(bot, group, message('No mention', '$p-plain', peer)), undefined);
  assert.equal(links.mention(bot, group, mentioning('From the owner', '$h-self', human, [bot])), undefined);
  assert.equal(links.mention(peer, group, mentioning('Self', '$p-self', peer, [peer])), undefined);
  const service = mentioning('Confirmation', '$svc', peer, [bot]); Object.assign(service.content!, { [SERVICE]: 'confirmation' });
  assert.equal(links.observe(bot, group, service), false);
  assert.equal(links.mention(bot, group, service), undefined);
  // An unpaid mention claiming credit the sender has is still refused.
  assert.equal(links.mention(bot, group, mentioning('Unreserved', '$p-unreserved', peer, [bot])), undefined);
  const forged = mentioning('Forged', '$p-forged', peer, [bot]); Object.assign(forged.content!, { [GRANT]: 'made-up' });
  assert.equal(links.mention(bot, group, forged), undefined);
  const question = paid(links, 'Question', '$p1', peer, [bot]);
  // Paying happens when the message is prepared, before anyone receives it.
  assert.equal(links.peerCredit(peer), PEER_CREDIT - 1);
  const first = links.mention(bot, group, question)!;
  assert.equal(first.sender, human);
  assert.notEqual(first.event_id, '$p1');
  assert.deepEqual(first.content![AGENT_TRIGGER], { agent: peer, event: '$p1', events: [] });
  // The sender paid one; the recipient keeps the larger reserve: the sender's remainder.
  assert.deepEqual([links.peerCredit(peer), links.peerCredit(bot)], [PEER_CREDIT - 1, PEER_CREDIT - 1]);
  // Each agent evaluates a peer event once, and credit survives a restart.
  assert.equal(links.mention(bot, group, question), undefined);
  links = f.load();
  assert.deepEqual([links.peerCredit(peer), links.peerCredit(bot)], [PEER_CREDIT - 1, PEER_CREDIT - 1]);
  const context = JSON.parse(links.prompt(bot, group, first, first.content!.body!).split('\n')[1]);
  assert.equal(context.author, peer);
  assert.equal(context.trigger, 'agent-mention');
  assert.match(links.prompt(bot, group, first, first.content!.body!), /Current connector notice:\n[^]*NO_REPLY/);
  assert.equal(context.peerCredit, PEER_CREDIT - 1);
  assert.match(routingInstructions, /matrix-mentions/);
  assert.ok(!links.prompt(bot, home, message('Hi', '$h4'), 'Hi').includes('matrix-mentions'));
});

test('peer credit is restored, never accumulated, and every exchange without the human runs out', t => {
  const f = pair(t), links = f.links;
  links.observe(bot, group, message('Task', '$h1'));
  // Repeated human messages restore the cap; they do not add up.
  for (let i = 0; i < 5; i++) links.credit(peer);
  assert.equal(links.peerCredit(peer), PEER_CREDIT);
  // A ping-pong between the agents ends with no new human message.
  let wakes = 0;
  for (let i = 0; i < 50; i++) {
    const [sender, recipient] = i % 2 ? [bot, peer] : [peer, bot];
    if (links.mention(recipient, group, paid(links, 'Ping', '$ping' + i, sender, [recipient]))) wakes++;
  }
  assert.ok(wakes > 0 && wakes < 2 * PEER_CREDIT + 1);
  assert.deepEqual([links.peerCredit(peer), links.peerCredit(bot)], [0, 0]);
  // The recipient keeps the larger reserve, not the sum.
  links.credit(bot); links.credit(peer);
  links.mention(bot, group, paid(links, 'Max', '$max', peer, [bot]));
  assert.equal(links.peerCredit(bot), PEER_CREDIT);
  // A reserve expires a day after its human message; passing it on does not renew it.
  links.credit(peer, Date.now() - 23 * 3_600_000);
  assert.equal(links.peerCredit(peer), PEER_CREDIT);
  links.credit(peer, Date.now() - 25 * 3_600_000);
  assert.equal(links.peerCredit(peer), 0);
  assert.equal(links.reserve(peer, group), undefined);
  assert.equal(links.mention(bot, group, paid(links, 'Stale', '$stale', peer, [bot])), undefined);
  // A sender without credit gets an explicit error instead of a silent mention.
  const refused = links.mentions(peer, group, 'Hi\n\n```matrix-mentions\n{"to":["' + bot + '"]}\n```')!;
  assert.deepEqual(refused.mentions, []);
  assert.match(refused.error!, /no peer credit/);
  // A grant is consumed once.
  links.credit(peer);
  const once = paid(links, 'Once', '$once', peer, [bot]);
  assert.ok(links.mention(bot, group, once));
  assert.equal(links.mention(bot, group, { ...once, event_id: '$once-copy' }), undefined);
  // A new human message voids unused grants: pending mentions never exceed the cap.
  const pending: MatrixEvent[] = [];
  for (let round = 0; round < 5; round++) {
    links.credit(peer);
    for (let n = 0; n < PEER_CREDIT; n++) pending.push(paid(links, 'Queued', `$queued-${round}-${n}`, peer, [bot]));
  }
  assert.equal(pending.filter(event => links.mention(bot, group, event)).length, PEER_CREDIT);
});

test('credit passed to the peer never adds to the peer\'s own pending mentions', t => {
  const f = pair(t), links = f.links;
  links.observe(bot, group, message('Task', '$h1'));
  const replies: MatrixEvent[] = [];
  // The human writes only to the reviewer; each time it starts the builder,
  // which prepares replies that are delivered only later.
  for (let round = 0; round < 5; round++) {
    links.credit(peer);
    assert.ok(links.mention(bot, group, paid(links, 'Start', `$start-${round}`, peer, [bot])));
    for (let n = 0; n < PEER_CREDIT; n++) {
      const reply = paid(links, 'Reply', `$reply-${round}-${n}`, bot, [peer]);
      if (reply.content![GRANT]) replies.push(reply);
    }
  }
  // The builder's reserve and pending replies never exceeded what it was passed.
  assert.ok(replies.filter(event => links.mention(peer, group, event)).length <= PEER_CREDIT - 1);
});

test('mention blocks are validated, removed and reported back to the agent', t => {
  const f = pair(t), links = f.links;
  links.observe(bot, group, message('Task', '$h1'));
  links.credit(bot);
  const block = (json: string) => 'Answer\n```matrix-mentions\n' + json + '\n```';
  assert.deepEqual(links.mentions(bot, group, block(`{"to":["${peer}","${peer}"]}`)), { text: 'Answer', mentions: [peer] });
  assert.deepEqual(links.mentions(bot, group, 'Plain reply'), { text: 'Plain reply', mentions: [] });
  // Examples inside another fence, a quote or a list are text, not requests.
  const example = 'See:\n````markdown\n' + block(`{"to":["${peer}"]}`) + '\n````';
  assert.deepEqual(links.mentions(bot, group, example), { text: example, mentions: [] });
  for (const nested of ['> ' + block(`{"to":["${peer}"]}`).replace(/\n/g, '\n> '), '- item\n\n  ```matrix-mentions\n  {"to":["' + peer + '"]}\n  ```']) {
    assert.deepEqual(links.mentions(bot, group, nested)!.mentions, []);
  }
  // The real block is removed by position, even after an identical example.
  const real = '```matrix-mentions\n{"to":["' + peer + '"]}\n```';
  const withExample = links.mentions(bot, group, '````markdown\n' + real + '\n````\n\nDone.\n\n' + real)!;
  assert.deepEqual(withExample.mentions, [peer]);
  assert.equal(withExample.text, '````markdown\n' + real + '\n````\n\nDone.');
  // A mentioning reply must fit into the quote its notice carries.
  const tooLong = links.mentions(bot, group, 'x'.repeat(MENTION_REPLY_LIMIT + 1) + '\n\n' + real)!;
  assert.deepEqual(tooLong.mentions, []);
  assert.match(tooLong.error!, /at most/);
  assert.equal(links.mentions(bot, home, block(`{"to":["${peer}"]}`)), undefined);
  for (const bad of [block(`{"to":["${human}"]}`), block(`{"to":["${bot}"]}`), block('{"to":'), block('{"to":[]}'),
    block(`{"to":["${peer}"]}`) + '\n' + block(`{"to":["${peer}"]}`)]) {
    const parsed = links.mentions(bot, group, bad)!;
    assert.deepEqual(parsed.mentions, []);
    assert.ok(parsed.error);
    assert.ok(!parsed.text.includes('matrix-mentions'));
  }
  const notes = () => JSON.parse(links.prompt(bot, group, message('Next', '$h2'), 'Next').split('\n')[1]).connectorNotes;
  assert.equal(notes().length, 5);
  links.acknowledge(bot);
  assert.equal(notes(), undefined);
  const reply = links.outgoing(bot, group, { msgtype: 'm.text', body: 'x' }, [peer], 'r1');
  assert.deepEqual(reply['m.mentions'], { user_ids: [peer] });
  assert.equal(reply[REPLY], 'r1');
  assert.equal(links.outgoing(bot, group, { msgtype: 'm.notice', body: 'x' }, undefined, 'r1')[REPLY], undefined);
  assert.deepEqual(links.outgoing(bot, home, { msgtype: 'm.text', body: 'x' }, [peer]), { msgtype: 'm.text', body: 'x' });
  assert.match(mentionText('Answer', [peer]), /\[@reviewer:test\]\(https:\/\/matrix\.to\/#\/@reviewer:test\)$/);
});

test('peer-started turns may stay silent, never steer and cannot be injected from Matrix', async t => {
  const f = pair(t), started = gate(), finish = gate();
  const calls: string[] = [], replies: string[] = [];
  let steers = 0;
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event),
    steer: async () => { steers++; return true; }, report: e => { throw e; },
    reply: async (_room, _event, text) => { replies.push(text); },
    run: async (_kind, prompt) => {
      calls.push(prompt);
      if (prompt === 'Long task') { started.release(); await finish.promise; return 'done'; }
      return prompt.includes('Another agent') ? 'NO_REPLY' : 'answer';
    },
  });
  f.links.observe(bot, group, message('Task', '$h1'));
  f.links.credit(peer);
  let asked = 0;
  const notice = () => f.links.mention(bot, group, paid(f.links, 'Question', '$p' + asked++, peer, [bot]))!;
  await bridge.handle(group, notice());
  assert.deepEqual(calls, []);
  await bridge.handleAgentMention(group, notice());
  assert.equal(calls.length, 1); assert.deepEqual(replies, []);
  const task = bridge.handle(group, message('Long task', '$long')); await started.promise;
  const replied = replies.length;
  f.links.observe(bot, group, message('Another task', '$h2'));
  f.links.credit(peer);
  await bridge.handleAgentMention(group, f.links.mention(bot, group, paid(f.links, 'While busy', '$busy', peer, [bot]))!);
  await bridge.handle(group, message('Follow-up', '$after'));
  assert.equal(steers, 1); assert.equal(f.state.queued(bot), 1); assert.equal(replies.length, replied + 1);
  finish.release(); await task;
  while (bridge.busy) await tick();
  assert.equal(calls.length, 3);
  assert.match(calls[2], /Another agent/);
});

test('an outgoing reply with a mention block starts the peer turn after attachments', async t => {
  const f = pair(t), sent: string[] = [], peerPrompts: string[] = [], events: MatrixEvent[] = [];
  const replyContentFor = (room: string, event: MatrixEvent, text: string, msgtype: 'm.text' | 'm.notice', mentions?: string[]) => {
    const contents = replyContent(mentions?.length ? mentionText(text, mentions) : text, true, true, msgtype);
    return contents.map((content, index) => f.links.outgoing(bot, room, content, index === contents.length - 1 ? mentions : undefined, 'reply-' + events.length));
  };
  // The human's message to the builder gives it credit to start the reviewer.
  f.links.credit(bot);
  const builder = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event), report: e => { throw e; },
    mentions: (room, text) => f.links.mentions(bot, room, text),
    sendAttachments: async () => { sent.push('attachment'); },
    reply: async (room, event, text, _markdown, msgtype = 'm.notice', mentions) => {
      sent.push(msgtype);
      for (const content of replyContentFor(room, event, text, msgtype, mentions)) {
        events.push({ type: 'm.room.message', sender: bot, event_id: '$out' + events.length, origin_server_ts: 3000, content });
      }
    },
    run: async () => ({ text: 'Please review.\n```matrix-mentions\n{"to":["' + peer + '"]}\n```', attachments: [{ path: '/x', root: '/' }] }),
  });
  const reviewer = new Bridge({ botId: peer, owner: human, kind: 'claude', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(peer, room, event), report: e => { throw e; },
    decoratePrompt: (room, event, prompt, steering) => f.links.prompt(peer, room, event, prompt, steering),
    reply: async () => {}, run: async (_kind, prompt) => { peerPrompts.push(prompt); return 'NO_REPLY'; },
  });
  const task = message('Build it', '$h1');
  f.links.observe(peer, group, task);
  await builder.handle(group, task);
  assert.deepEqual(sent.filter(s => s !== 'm.notice'), ['attachment', 'm.text']);
  const reply = events.at(-1)!;
  assert.deepEqual(reply.content!['m.mentions'], { user_ids: [peer] });
  assert.ok(!reply.content!.body!.includes('matrix-mentions'));
  // The same path main.ts uses for the peer's incoming Matrix event.
  assert.equal(f.links.observe(peer, group, reply), true);
  await reviewer.handleAgentMention(group, f.links.mention(peer, group, reply)!);
  assert.equal(peerPrompts.length, 1);
  const context = JSON.parse(peerPrompts[0].split('\n')[1]);
  assert.equal(context.trigger, 'agent-mention');
  // The question arrives quoted in the notice, not again as an observation.
  assert.match(peerPrompts[0], /Current connector notice:[^]*Please review\./);
  assert.ok(!(context.unreadSharedMessages ?? []).some((m: { id: string }) => m.id === reply.event_id));
  // An agent is not sent its own messages back.
  f.links.acknowledge(peer);
  f.links.observe(peer, group, message('Own reply', '$own', peer));
  const next = JSON.parse(f.links.prompt(peer, group, message('Next', '$h2'), 'Next').split('\n')[1]);
  assert.equal(next.unreadSharedMessages, undefined);
  assert.equal(next.remainingMessages, undefined);
});

test('mentions trigger once per recipient in any delivery order and carry the whole question', t => {
  for (const order of [[peer, bot], [bot, peer]]) {
    const f = pair(t);
    f.links.observe(bot, group, message('Task', '$h1'));
    f.links.credit(peer);
    const question = paid(f.links, 'Question', '$q', peer, [bot]);
    const starts = order.map(id => { f.links.observe(id, group, question); return f.links.mention(id, group, question); }).filter(Boolean);
    assert.equal(starts.length, 1);
  }
  const f = pair(t);
  const part = (body: string, id: string, reply: string) => { const event = message(body, id, peer); Object.assign(event.content!, { [REPLY]: reply }); return event; };
  f.links.observe(bot, group, message('Task', '$h1'));
  f.links.observe(bot, group, part('x'.repeat(15_000), '$backlog', 'r0'));
  f.links.observe(bot, group, part('Earlier part. ', '$part1', 'r1'));
  f.links.credit(peer);
  const last = paid(f.links, 'Please review the parser.', '$part2', peer, [bot]);
  Object.assign(last.content!, { [REPLY]: 'r1' });
  f.links.observe(bot, group, last);
  const notice = f.links.mention(bot, group, last)!;
  assert.deepEqual(notice.content![AGENT_TRIGGER]!.events, ['$part1', '$part2']);
  assert.match(f.links.prompt(bot, group, notice, notice.content!.body!), /Earlier part\. Please review the parser\./);
  // The quoted parts are not delivered a second time as observations.
  f.links.acknowledge(bot);
  const next = JSON.parse(f.links.prompt(bot, group, message('Next', '$h2'), 'Next').split('\n')[1]);
  assert.ok(!(next.unreadSharedMessages ?? []).some((m: { id: string }) => m.id === '$part1' || m.id === '$part2'));
  // Reply IDs group parts internally and are not shown to agents.
  assert.ok(next.unreadSharedMessages.length > 0);
  assert.ok(next.unreadSharedMessages.every((m: object) => !('reply' in m)));
  // An oversized reply from another installation is quoted partially and stays unread in full.
  const g = pair(t);
  g.links.observe(bot, group, message('Task', '$h1'));
  g.links.observe(bot, group, part('IMPORTANT-FIRST-PART' + 'y'.repeat(9000), '$big1', 'r2'));
  g.links.credit(peer);
  const tail = paid(g.links, 'Short question?', '$big2', peer, [bot]);
  Object.assign(tail.content!, { [REPLY]: 'r2' });
  g.links.observe(bot, group, tail);
  const partial = g.links.mention(bot, group, tail)!;
  assert.deepEqual(partial.content![AGENT_TRIGGER]!.events, []);
  assert.match(g.links.prompt(bot, group, partial, partial.content!.body!), /IMPORTANT-FIRST-PART[^]*"truncated":true/);
});

test('an agent may decline a shared-room human message with NO_REPLY, but not a private one', async t => {
  const f = fixture(t), replies: [string, string][] = [];
  const bridge = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event), shared: room => !!f.links.room(bot, room),
    run: async () => 'NO_REPLY', reply: async (room, _event, text) => { replies.push([room, text]); }, report: e => { throw e; },
  });
  await bridge.handle(group, message('For the reviewer', '$shared'));
  // No acknowledgement and no answer in the shared room.
  assert.equal(replies.length, 0);
  await bridge.handle(home, message('Hello', '$private'));
  assert.deepEqual(replies, [[home, '…'], [home, 'NO_REPLY']]);
  assert.match(routingInstructions, /Only in shared rooms:[^]*exactly NO_REPLY/);
  // Declining drops only the text: attachments are still delivered.
  const sent: string[] = [];
  const withFile = new Bridge({ botId: bot, owner: human, kind: 'codex', state: f.state, since: 0, timeoutMs: 5000,
    isAuthorized: id => id === human, isPrivateRoom: async () => true,
    linkedSession: (room, event) => f.links.key(bot, room, event), shared: room => !!f.links.room(bot, room),
    run: async () => ({ text: 'NO_REPLY', attachments: [{ path: '/x', root: '/' }] }),
    sendAttachments: async () => { sent.push('attachment'); }, reply: async (_room, _event, text) => { sent.push(text); }, report: e => { throw e; },
  });
  await withFile.handle(group, message('Send the file', '$file'));
  assert.deepEqual(sent, ['attachment']);
});
