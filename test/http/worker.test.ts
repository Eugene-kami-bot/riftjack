import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WorkerQueue } from '../../src/worker-queue.js';
import { WorkerService } from '../../src/worker-service.js';
import { WorkerServer } from '../../src/worker-server.js';
import { WorkerBridge } from '../../src/worker-bridge.js';
import { State } from '../../src/state.js';

const event = (id = '$one', body = 'hello') => ({ type: 'm.room.message', event_id: id, sender: '@alice:test', origin_server_ts: 1000, content: { msgtype: 'm.text', body } });
function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-worker-http-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
const idle = async (service: WorkerService) => { while (service.busy) await new Promise(resolve => setTimeout(resolve, 1)); };

test('worker HTTP API authenticates per bot, supports long polling, and validates replies', async t => {
  const dir = realpathSync(directory(t)), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const audioPath = join(dir, 'voice.ogg'); writeFileSync(audioPath, 'audio');
  const transcription = { status: 'complete' as const, text: 'Example speech.', automatic: true as const };
  const service = new WorkerService(queue, join(dir, 'files'), 10, { allowed: async () => true,
    receive: async () => ({ path: audioPath, name: 'voice.ogg', image: false, mimetype: 'audio/ogg', size: 5 }),
    transcribe: async file => ({ ...file, transcription }),
    prepare: async task => [{ text: task.response!.text }], send: async () => {}, report: () => {} });
  const roomCalls: unknown[] = [];
  const server = new WorkerServer(); server.add('@grok:test', 'a'.repeat(43), service, async input => {
    roomCalls.push(input);
    const request = input as { action?: string; room?: string };
    return JSON.stringify(request.action === 'list' ? { rooms: [{ room: '!shared:test', type: 'shared', agents: ['@grok:test', '@peer:test'] }] }
      : { status: 'sent', room: request.room, event_id: '$worker-room' });
  });
  const port = await server.start(0);
  t.after(async () => { service.stop(); await server.stop(); queue.close(); });
  const base = `http://127.0.0.1:${port}/v1/bots/%40grok%3Atest/tasks`;
  const request = (path = '', body?: object, token = 'a'.repeat(43)) => fetch(base + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });
  assert.equal((await request('', undefined, 'b'.repeat(43))).status, 401);
  assert.equal((await fetch(base.replace('grok', 'other'), { headers: { Authorization: 'Bearer ' + 'a'.repeat(43) } })).status, 401);
  const roomsUrl = base.replace(/\/tasks$/, '/rooms');
  assert.equal((await fetch(roomsUrl, { method: 'POST', headers: { Origin: 'https://browser.test', Authorization: 'Bearer ' + 'a'.repeat(43), 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.deepEqual(await (await fetch(roomsUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(43), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) })).json(),
    { rooms: [{ room: '!shared:test', type: 'shared', agents: ['@grok:test', '@peer:test'] }] });
  const waiting = request('?wait=2');
  setTimeout(() => queue.enqueue('!dm:test', event(), 'c'), 20);
  const task = (await (await waiting).json()).task;
  assert.ok(task.id); assert.equal(task.text, 'hello');
  assert.deepEqual(await (await request()).json(), { task: null });
  assert.equal((await request('/' + task.id + '/reply', { lease: 'wrong', text: 'reply' })).status, 409);
  assert.equal((await request('/' + task.id + '/reply', { lease: task.lease, files: [{ name: 'x', data: Buffer.alloc(11).toString('base64') }] })).status, 413);
  assert.equal((await request('/' + task.id + '/reply', { lease: task.lease, text: 'reply' })).status, 200);
  await idle(service);
  assert.equal((await (await request('/' + task.id)).json()).status, 'delivered');
  assert.equal((await request('/' + task.id + '/reply', { lease: task.lease, text: 'different' })).status, 409);
  const tokenFile = join(dir, 'token'), taskFile = join(dir, 'task.json'), replyFile = join(dir, 'reply.txt'), roomFile = join(dir, 'room.txt');
  writeFileSync(tokenFile, 'a'.repeat(43), { mode: 0o600 }); writeFileSync(replyFile, 'reply from CLI');
  writeFileSync(roomFile, 'delegate from CLI');
  queue.enqueue('!dm:test', event('$cli'), 'c');
  const cli = (...args: string[]) => promisify(execFile)('python3', [fileURLToPath(new URL('../../scripts/worker-client.py', import.meta.url)),
    '--url', `http://127.0.0.1:${port}`, '--bot', '@grok:test', '--token-file', tokenFile, ...args]);
  const claimed = JSON.parse((await cli('wait', '--seconds', '1')).stdout);
  assert.equal(claimed.text, 'hello'); writeFileSync(taskFile, JSON.stringify(claimed));
  assert.ok(JSON.parse((await cli('renew', taskFile)).stdout).leaseUntil);
  const savedAudio = join(dir, 'saved.ogg');
  const saved = JSON.parse((await cli('attachment', taskFile, '--output', savedAudio)).stdout);
  assert.deepEqual(saved.transcription, transcription);
  assert.equal(readFileSync(savedAudio, 'utf8'), 'audio');
  assert.equal(JSON.parse((await cli('reply', taskFile, '--text-file', replyFile)).stdout).status, 'replied');
  await idle(service);
  assert.equal(JSON.parse((await cli('status', taskFile)).stdout).status, 'delivered');
  assert.equal(JSON.parse((await cli('rooms')).stdout).rooms[0].room, '!shared:test');
  assert.deepEqual(JSON.parse((await cli('send', '--room', '!shared:test', '--text-file', roomFile, '--id', 'telegram-1', '--mention',
    '--owner-turn-id', 'telegram:update-1', '--owner-turn-time', String(Date.now()))).stdout),
  { status: 'sent', room: '!shared:test', event_id: '$worker-room' });
  assert.deepEqual(roomCalls.at(-1), { action: 'send', room: '!shared:test', text: 'delegate from CLI', id: 'telegram-1', mention: true,
    owner_turn: { id: 'telegram:update-1', time: roomCalls.at(-1) && (roomCalls.at(-1) as any).owner_turn.time } });
  const mcp = spawn('python3', [fileURLToPath(new URL('../../scripts/worker-client.py', import.meta.url)),
    '--url', `http://127.0.0.1:${port}`, '--bot', '@grok:test', '--token-file', tokenFile, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { mcp.kill(); });
  const lines = createInterface({ input: mcp.stdout! });
  const replies: any[] = []; lines.on('line', line => replies.push(JSON.parse(line)));
  const call = async (message: object) => {
    const count = replies.length; mcp.stdin!.write(JSON.stringify(message) + '\n');
    while (replies.length === count) await new Promise(resolve => setTimeout(resolve, 5));
    return replies.at(-1);
  };
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).result.serverInfo.name, 'riftjack-worker-rooms');
  assert.equal((await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools[0].name, 'room_messages');
  const listed = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'room_messages', arguments: { action: 'list' } } });
  assert.equal(JSON.parse(listed.result.content[0].text).rooms[0].room, '!shared:test');
  mcp.stdin!.end(); lines.close(); mcp.kill();
  const bridge = new WorkerBridge({ botId: '@grok:test', authorized: sender => sender === '@alice:test', privateRoom: async () => true,
    queue, service, state: new State(join(dir, 'state.json')), reply: async () => assert.fail('No acknowledgement for reactions'),
    reactionTarget: async () => ({ type: 'm.room.message', event_id: '$answer', sender: '@grok:test',
      content: { msgtype: 'm.text', body: 'Earlier worker answer.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } }),
  });
  await bridge.handle('!dm:test', { type: 'm.reaction', event_id: '$like', sender: '@alice:test', origin_server_ts: 1000,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$answer', key: '❤️' } } });
  const feedback = (await (await request()).json()).task;
  assert.match(feedback.text, /strong appreciation or support/); assert.match(feedback.text, /Earlier worker answer/);
  assert.ok(feedback.conversation.includes('$thread'));

});
