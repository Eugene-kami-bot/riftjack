import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reactionFeedback, feedbackMeaning } from '../src/reaction-feedback.js';
import { Bridge, sessionKey, type MatrixEvent, type Backend } from '../src/bridge.js';
import { State } from '../src/state.js';
import { WorkerBridge } from '../src/worker-bridge.js';
import { WorkerQueue } from '../src/worker-queue.js';
import { WorkerService } from '../src/worker-service.js';

const owner = '@alice:test', bot = '@bot:test', room = '!dm:test';
const reaction = (key = '👍', id = '$reaction'): MatrixEvent => ({ type: 'm.reaction', event_id: id, sender: owner, origin_server_ts: 1000,
  content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$answer', key } } });
const target = (thread?: string): MatrixEvent => ({ type: 'm.room.message', event_id: '$answer', sender: bot, room_id: room,
  content: { msgtype: 'm.text', body: 'An earlier answer.', ...(thread && { 'm.relates_to': { rel_type: 'm.thread', event_id: thread } }) } });
const message = (body = 'Start'): MatrixEvent => ({ type: 'm.room.message', event_id: '$message', sender: owner, origin_server_ts: 1000, content: { msgtype: 'm.text', body } });
const options = (answer: MatrixEvent | undefined = target()) => ({ botId: bot, authorized: (sender: string) => sender === owner,
  privateRoom: async () => true, read: async (r: string, id: string) => { assert.equal(r, room); assert.equal(id, '$answer'); return answer; } });
const payload = (event: MatrixEvent) => JSON.parse(event.content!.body!.split('\n')[1]);
function directory(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'riftjack-feedback-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
}

test('thumbs and hearts carry feedback about the exact message and its original thread', async () => {
  for (const [emoji, meaning] of [['👍', 'agreement'], ['👍🏽', 'agreement'], ['👎', 'negative'], ['👎🏻', 'negative'], ['❤️', 'strong appreciation'], ['❤', 'strong appreciation'], ['♥️', 'strong appreciation']]) {
    const result = await reactionFeedback(room, reaction(emoji), options(target('$thread')));
    assert.ok(result); assert.equal(result.event_id, '$reaction');
    assert.equal(payload(result).reaction, emoji); assert.match(payload(result).meaning, new RegExp(meaning));
    assert.equal(payload(result).message, 'An earlier answer.');
    assert.equal(result.content!['m.relates_to']!.event_id, '$thread');
    assert.equal(sessionKey(room, result), sessionKey(room, { ...message(), content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } }));
    assert.match(result.content!.body!, /continue the agreed work/);
    assert.match(result.content!.body!, /within the agreed work, either can mean "yes, go ahead"/);
    assert.match(result.content!.body!, /do not invent a new task/);
    assert.match(result.content!.body!, /do not answer pending confirmation requests or replace required approvals/);
    assert.doesNotMatch(result.content!.body!, /Respond briefly|not permission to run commands/);
  }
  assert.equal((await reactionFeedback(room, reaction(), options()))!.content!['m.relates_to'], undefined);
  for (const emoji of ['✅', '❌', '👍 !approve', '🚀', '', undefined]) assert.equal(feedbackMeaning(emoji), undefined);
});

test('feedback never quotes another sender, another room, notices, missing or redacted messages', async () => {
  const original = target();
  for (const bad of [undefined, { ...original, sender: owner }, { ...original, event_id: '$other' },
    { ...original, room_id: '!other:test' }, { ...original, type: 'm.room.encrypted' },
    { ...original, content: { msgtype: 'm.notice', body: 'Confirmation' } }, { ...original, content: {} },
    { ...original, content: { msgtype: 'm.text', body: 'Edit', 'm.relates_to': { rel_type: 'm.replace', event_id: '$earlier' } } }]) {
    assert.equal(await reactionFeedback(room, reaction(), { ...options(), read: async () => bad }), undefined);
  }
});

test('feedback checks privacy and access before reading and again after reading', async () => {
  let reads = 0, allowed = true, privateRoom = true;
  const config = { ...options(), authorized: (sender: string) => allowed && sender === owner,
    privateRoom: async () => privateRoom, read: async () => { reads++; allowed = false; return target(); } };
  assert.equal(await reactionFeedback(room, { ...reaction(), sender: '@stranger:test' }, config), undefined);
  privateRoom = false;
  assert.equal(await reactionFeedback(room, reaction(), config), undefined); assert.equal(reads, 0);
  privateRoom = true;
  assert.equal(await reactionFeedback(room, reaction(), config), undefined); assert.equal(reads, 1);
  allowed = true;
  config.read = async () => { privateRoom = false; return target(); };
  assert.equal(await reactionFeedback(room, reaction(), config), undefined);
});

test('quoted feedback is bounded and cannot become a connector command', async () => {
  const answer = target(); answer.content!.body = '!approve\n' + '\u0001'.repeat(10_000);
  const result = await reactionFeedback(room, reaction(), options(answer)); assert.ok(result);
  assert.ok(result.content!.body!.length < 16_000); assert.equal(payload(result).truncated, true);
  assert.ok(payload(result).message.startsWith('!approve')); assert.ok(!result.content!.body!.startsWith('!'));
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} starts on feedback immediately, once, without an acknowledgement message`, async t => {
  const calls: { prompt: string; key: string }[] = [], replies: string[] = [];
  const state = new State(join(directory(t), 'state.json'));
  const bridge = new Bridge({ botId: bot, owner, kind, since: 0, timeoutMs: 1000, state, isAuthorized: s => s === owner,
    isPrivateRoom: async () => true, reactionTarget: options(target('$thread')).read,
    run: async (_mode, prompt, key) => { calls.push({ prompt, key }); return 'Thanks for the feedback.'; },
    reply: async (_r, _e, text) => { replies.push(text); }, report: error => { throw error; } });
  await bridge.handle(room, reaction('❤️')); await bridge.handle(room, reaction('❤️'));
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /strong appreciation or support/);
  assert.equal(calls[0].key, JSON.stringify([room, owner, '$thread']));
  assert.deepEqual(replies, ['Thanks for the feedback.']);
  await bridge.handle(room, reaction('✅', '$approval'));
  await bridge.handle(room, reaction('❌', '$denial'));
  assert.equal(calls.length, 1);
});

for (const accepted of [true, false]) test(`active feedback is ${accepted ? 'steered' : 'queued'} without chat noise`, async t => {
  const begun = deferred(), release = deferred(), prompts: string[] = [], updates: string[] = [], replies: string[] = [];
  const state = new State(join(directory(t), 'state.json'));
  const run: Backend = async (_m, prompt) => { prompts.push(prompt); if (prompts.length === 1) { begun.resolve(); await release.promise; } return 'Answer'; };
  const bridge = new Bridge({ botId: bot, owner, kind: accepted ? 'codex' : 'claude', since: 0, timeoutMs: 2000, state,
    isAuthorized: s => s === owner, isPrivateRoom: async () => true, reactionTarget: options().read, run,
    steer: async prompt => { updates.push(prompt); return accepted; },
    reply: async (_r, _e, text) => { replies.push(text); }, report: error => { throw error; } });
  const task = bridge.handle(room, message()); await begun.promise;
  try {
    await bridge.handle(room, reaction('👎'));
    assert.equal(updates.length, 1); assert.match(updates[0], /negative feedback/);
    assert.deepEqual(replies, []);
  } finally { release.resolve(); await task; }
  assert.equal(prompts.length, accepted ? 1 : 2);
});

test('thumbs on an unrelated message cannot approve a pending confirmation', async t => {
  const begun = deferred(); let decision: object | undefined;
  const state = new State(join(directory(t), 'state.json'));
  const bridge = new Bridge({ botId: bot, owner, kind: 'codex', since: 0, timeoutMs: 2000, state,
    isAuthorized: s => s === owner, isPrivateRoom: async () => true, reactionTarget: options().read,
    run: async (_m, _p, _k, signal, _s, _a, interact) => { decision = await interact!({ text: 'Permission', approve: { yes: true }, deny: { yes: false } }, signal); return 'Done'; },
    steer: async () => true,
    confirmation: async (_r, _e, _text, controls) => { controls.bind('$confirmation'); begun.resolve(); },
    reply: async () => {}, report: () => {} });
  const task = bridge.handle(room, message()); await begun.promise;
  await bridge.handle(room, reaction('👍')); assert.equal(decision, undefined);
  await bridge.handle(room, { ...message('!deny'), event_id: '$deny' }); await task;
  assert.deepEqual(decision, { yes: false });
});

test('Grok feedback enters the durable worker queue in the target thread and deduplicates after restart', async t => {
  const root = directory(t), path = join(root, 'queue.sqlite');
  let queue = new WorkerQueue(path); t.after(() => queue.close());
  const service = new WorkerService(queue, join(root, 'files'), 1024, { allowed: async () => true, receive: async () => undefined,
    prepare: async () => [], send: async () => {}, report: () => {} });
  const state = new State(join(root, 'state.json'));
  const config = { botId: bot, authorized: (s: string) => s === owner, privateRoom: async () => true,
    reactionTarget: options(target('$thread')).read, queue, service, state, reply: async () => assert.fail('No feedback acknowledgement') };
  const bridge = new WorkerBridge(config);
  await bridge.handle(room, reaction('👍')); await bridge.handle(room, reaction('👍'));
  assert.equal(queue.list().length, 1);
  const task = queue.list()[0]; assert.match(task.event.content!.body!, /yes, go ahead/);
  assert.ok(task.conversation.startsWith(JSON.stringify([room, owner, '$thread']) + '\n'));
  queue.close(); queue = new WorkerQueue(path);
  await new WorkerBridge({ ...config, queue }).handle(room, reaction('👍'));
  assert.equal(queue.list().length, 1); assert.equal(queue.list()[0].id, task.id);
});
