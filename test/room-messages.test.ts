import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomMessageDelivery } from '../src/room-messages.js';
import { Bridge, type BackendHooks } from '../src/bridge.js';
import { State } from '../src/state.js';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const signal = new AbortController().signal;
const request = { action: 'send', room: '!shared:test', text: 'Ready for review.', id: 'review-1' };

test('room sends deduplicate concurrent calls and uncertain failures by message id', async () => {
  let calls = 0;
  const action = roomMessageDelivery(async () => { calls++; await Promise.resolve(); return 'sent'; });
  assert.deepEqual(await Promise.all([action(request, signal), action(request, signal)]), ['sent', 'sent']);
  assert.equal(calls, 1);
  await assert.rejects(action({ ...request, text: 'Changed' }, signal), /different content/);
  const failed = roomMessageDelivery(async () => { calls++; throw new Error('Disconnected after delivery'); });
  await assert.rejects(failed(request, signal));
  await assert.rejects(failed(request, signal));
  assert.equal(calls, 2);
});

test('room sends reject malformed input, extra authority fields and oversized Unicode text', async () => {
  let calls = 0;
  const action = roomMessageDelivery(async () => { calls++; return '{}'; });
  for (const input of [null, [], {}, { action: 'list', room: '!shared:test' },
    { ...request, sender: '@other:test' }, { ...request, mentions: ['@bot:test'] },
    { ...request, text: ' ' }, { ...request, text: '界'.repeat(2667) },
    { ...request, room: 'somewhere' }, { ...request, id: '' }]) await assert.rejects(action(input, signal));
  assert.equal(calls, 0);
  await action({ ...request, text: '界'.repeat(2666) }, signal);
  await action({ action: 'list' }, signal);
  assert.equal(calls, 2);
});

test('attachment actions validate event ids and pin sends to the backend outbox', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'room-files-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests: unknown[] = [];
  const action = roomMessageDelivery(async request => { requests.push(request); return '{}'; });
  const receive = { action: 'receive_attachment', room: '!shared:test', event_id: '$image' };
  const files = { action: 'send_files', room: '!shared:test', id: 'files-1', files: [{ path: 'picture.png', name: 'Picture' }] };
  for (const input of [
    { ...receive, event_id: 'invalid' }, { ...receive, event_id: '$bad id' }, { ...receive, room: 'invalid' },
    { ...receive, sender: '@alice:test' }, { ...files, outbox: root }, { ...files, mention: true },
    { ...files, files: [] }, { ...files, files: [{ path: '../secret' }] },
    { ...files, files: [{ path: '/secret' }] }, { ...files, files: [{ path: 'file', root }] },
    { ...files, files: Array(11).fill({ path: 'file' }) },
  ]) await assert.rejects(action(input, signal, root));
  await assert.rejects(action(files, signal));
  assert.equal(requests.length, 0);
  await action(receive, signal);
  await action(files, signal, root); await action(files, signal, root);
  await action({ ...files, files: [{ name: 'Picture', path: 'picture.png' }] }, signal, root);
  await assert.rejects(action({ ...files, files: [{ path: 'other' }] }, signal, root), /different content/);
  await assert.rejects(action({ ...request, id: files.id }, signal), /different content/);
  assert.deepEqual(requests, [receive, { ...files, outbox: root }]);
});

test('room tool expires with its turn and rechecks source authorization even for a cached request', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'room-tool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let hooks: BackendHooks | undefined, calls = 0, authorized = true;
  const bridge = new Bridge({ botId: '@bot:test', kind: 'codex', since: 0, timeoutMs: 5000,
    state: new State(join(dir, 'state.json')), isAuthorized: () => authorized, isPrivateRoom: async () => true,
    reply: async () => {}, report: () => {},
    roomMessages: async (_request, context) => { assert.equal(context.room, '!home:test'); calls++; return 'sent'; },
    run: async (_kind, _prompt, _key, _signal, _sender, _files, _interact, _publish, supplied) => {
      hooks = supplied;
      await hooks!.roomMessages!(request, signal);
      authorized = false;
      await assert.rejects(hooks!.roomMessages!(request, signal));
      authorized = true;
      return 'done';
    },
  });
  t.after(() => bridge.stop());
  await bridge.handle('!home:test', { type: 'm.room.message', sender: '@alice:test', event_id: '$1', origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body: 'Share the result.' } });
  assert.equal(calls, 1);
  assert.ok(hooks?.roomMessages);
  await assert.rejects(hooks.roomMessages(request, signal));
  assert.equal(calls, 1);
});
