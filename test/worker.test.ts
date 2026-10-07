import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerQueue } from '../src/worker-queue.js';
import { WorkerService } from '../src/worker-service.js';
import { WorkerBridge } from '../src/worker-bridge.js';
import { WorkerMatrixClient } from '../src/worker-matrix-client.js';
import { SimpleFsStorageProvider } from '@vector-im/matrix-bot-sdk';
import { State } from '../src/state.js';
import { parseManagerRequest } from '../src/accounts.js';
import { loadConfig } from '../src/config.js';

const event = (id = '$one', body = 'hello') => ({ type: 'm.room.message', event_id: id, sender: '@alice:test', origin_server_ts: 1000, content: { msgtype: 'm.text', body } });
function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'riftjack-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
const idle = async (service: WorkerService) => { while (service.busy) await new Promise(resolve => setTimeout(resolve, 1)); };

test('attachment downloads are shared, persisted across restart and guarded on every cached read', async t => {
  const dir = realpathSync(directory(t)), db = join(dir, 'queue.sqlite'), path = join(dir, 'attachment.txt');
  writeFileSync(path, 'hello');
  let queue = new WorkerQueue(db), downloads = 0, transcriptions = 0, allowed = true;
  const transcription = { status: 'complete' as const, text: 'Example speech.', automatic: true as const };
  const transport = { allowed: async () => allowed, receive: async () => {
    downloads++; await new Promise(resolve => setTimeout(resolve, 10));
    return { path, name: 'attachment.txt', size: 5, mimetype: 'text/plain', image: false };
  }, transcribe: async (file: import('../src/media.js').IncomingAttachment) => { transcriptions++; return { ...file, transcription }; },
    prepare: async () => [], send: async () => {}, report: () => {} };
  let service = new WorkerService(queue, join(dir, 'files'), 100, transport);
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  const replies = await Promise.all([service.attachment(task.id, task.lease!), service.attachment(task.id, task.lease!)]);
  assert.equal(downloads, 1); assert.deepEqual(replies[0], replies[1]);
  assert.equal(Buffer.from(replies[0].data, 'base64').toString(), 'hello');
  assert.deepEqual(replies[0].transcription, transcription);
  service.stop(); queue.close(); queue = new WorkerQueue(db);
  service = new WorkerService(queue, join(dir, 'files'), 100, transport);
  t.after(() => { service.stop(); queue.close(); });
  assert.deepEqual(await service.attachment(task.id, task.lease!), replies[0]);
  assert.equal(downloads, 1);
  assert.equal(transcriptions, 1);
  queue.release(task.id, task.lease!);
  const renewed = queue.claim(task.id)!;
  await assert.rejects(service.attachment(task.id, task.lease!), /replaced/);
  assert.deepEqual(await service.attachment(task.id, renewed.lease!), replies[0]);
  allowed = false;
  await assert.rejects(service.attachment(task.id, renewed.lease!), /privacy changed/);
  assert.equal(downloads, 1);
});

test('revocation during transcription withholds and does not cache the worker result', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  let allowed = true;
  const service = new WorkerService(queue, join(dir, 'files'), 100, {
    allowed: async () => allowed,
    receive: async () => ({ path: '/audio', name: 'audio', size: 1, image: false, mimetype: 'audio/ogg' }),
    transcribe: async file => { allowed = false; return { ...file, transcription: { status: 'complete', text: 'Private speech.', automatic: true } }; },
    prepare: async () => [], send: async () => {}, report: () => {},
  });
  t.after(() => { service.stop(); queue.close(); });
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  await assert.rejects(service.attachment(task.id, task.lease!), /privacy changed/);
  assert.equal(queue.get(task.id).attachment, undefined);
});

test('failed attachment downloads can be retried without poisoning the cache', async t => {
  const dir = realpathSync(directory(t)), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const path = join(dir, 'attachment.txt'); writeFileSync(path, 'hello');
  let downloads = 0;
  const service = new WorkerService(queue, join(dir, 'files'), 100, { allowed: async () => true,
    receive: async () => { if (++downloads === 1) throw new Error('Download failed');
      return { path, name: 'attachment.txt', size: 5, mimetype: 'text/plain', image: false }; },
    prepare: async () => [], send: async () => {}, report: () => {} });
  t.after(() => { service.stop(); queue.close(); });
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  await assert.rejects(service.attachment(task.id, task.lease!), /Download failed/);
  assert.equal((await service.attachment(task.id, task.lease!)).name, 'attachment.txt');
  assert.equal(downloads, 2);
});

test('a delayed privacy check observes an attachment cached by another request', async t => {
  const dir = realpathSync(directory(t)), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const path = join(dir, 'attachment.txt'); writeFileSync(path, 'hello');
  let release!: () => void, checked!: () => void, checks = 0, downloads = 0;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { checked = resolve; });
  const service = new WorkerService(queue, join(dir, 'files'), 100, { allowed: async () => {
    if (++checks === 1) { checked(); await delayed; } return true;
  }, receive: async () => { downloads++; return { path, name: 'attachment.txt', size: 5, mimetype: 'text/plain', image: false }; },
  prepare: async () => [], send: async () => {}, report: () => {} });
  t.after(() => { service.stop(); queue.close(); });
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  const first = service.attachment(task.id, task.lease!); await started;
  const second = await service.attachment(task.id, task.lease!);
  release(); assert.deepEqual(await first, second); assert.equal(downloads, 1);
});

test('cancelling a lease during the final cached read authorization prevents disclosure', async t => {
  const dir = realpathSync(directory(t)), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const path = join(dir, 'attachment.txt'); writeFileSync(path, 'hello');
  let cancel = false, checks = 0;
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  const service = new WorkerService(queue, join(dir, 'files'), 100, { allowed: async () => {
    if (cancel && ++checks === 2) queue.cancel(task.id); return true;
  }, receive: async () => ({ path, name: 'attachment.txt', size: 5, mimetype: 'text/plain', image: false }),
  prepare: async () => [], send: async () => {}, report: () => {} });
  t.after(() => { service.stop(); queue.close(); });
  await service.attachment(task.id, task.lease!);
  cancel = true;
  await assert.rejects(service.attachment(task.id, task.lease!), /cancelled/);
});

test('durable inbox deduplicates events, leases exclusively, and rejects stale results after restart', t => {
  const dir = directory(t), file = join(dir, 'queue.sqlite'); let now = 1000;
  let queue = new WorkerQueue(file, () => now, 100);
  const control = queue.enqueue('!dm:test', event('$control', '!cancel'), 'conversation', true);
  assert.equal(queue.candidate(), undefined);
  const original = queue.enqueue('!dm:test', event(), 'conversation');
  assert.equal(queue.enqueue('!dm:test', event(), 'conversation').id, original.id);
  const a = queue.claim(original.id)!; assert.equal(queue.candidate(), undefined);
  assert.equal(queue.claim(original.id), undefined);
  queue.close(); queue = new WorkerQueue(file, () => now, 100);
  assert.equal(queue.candidate(), undefined);
  assert.equal(queue.get(control.id).status, 'control');
  now += 101;
  const b = queue.claim(original.id)!;
  assert.notEqual(a.lease, b.lease); assert.equal(b.attempt, 2);
  assert.throws(() => queue.complete(a.id, a.lease!, 'old reply', []), /Lease expired/);
  assert.equal(queue.complete(b.id, b.lease!, 'reply', []).status, 'replied');
  assert.equal(queue.complete(b.id, b.lease!, 'reply', []).status, 'replied');
  assert.throws(() => queue.complete(b.id, b.lease!, 'changed', []), /different reply/);
  queue.close();
});

test('renewal, release and cancellation persist, and cancellation invalidates an active lease', t => {
  const queue = new WorkerQueue(join(directory(t), 'queue.sqlite'), () => 1000, 100);
  const a = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  assert.equal(queue.renew(a.id, a.lease!).leaseUntil, 1100);
  queue.release(a.id, a.lease!);
  const b = queue.claim(a.id)!;
  assert.notEqual(b.lease, a.lease);
  queue.cancelWhere(task => task.conversation === 'c');
  assert.throws(() => queue.renew(b.id, b.lease!), /cancelled/);
  assert.equal(queue.candidate(), undefined); queue.close();
});

test('accepted replies survive restart and lost Matrix send responses reuse the same encrypted event and transaction', async t => {
  const dir = directory(t), file = join(dir, 'queue.sqlite');
  let queue = new WorkerQueue(file); let prepared = 0, failed = false;
  const sends = new Map<string, unknown>(), attempts: string[] = [];
  const transport = {
    allowed: async () => true, receive: async () => undefined,
    prepare: async () => { prepared++; return [{ ciphertext: 'fixed' }]; },
    send: async (_task: unknown, transaction: string, encrypted: unknown) => {
      attempts.push(transaction); sends.set(transaction, encrypted);
      if (!failed) { failed = true; throw new Error('response lost after server accepted event'); }
    }, report: () => {},
  };
  let service = new WorkerService(queue, join(dir, 'files'), 100, transport);
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  await service.complete(task.id, task.lease!, { text: 'reply' }); await idle(service);
  assert.equal(queue.get(task.id).status, 'replied');
  service.stop(); queue.close();
  queue = new WorkerQueue(file); service = new WorkerService(queue, join(dir, 'files'), 100, transport);
  await service.deliver();
  assert.equal(prepared, 1); assert.equal(sends.size, 1);
  assert.equal(attempts[0], attempts[1]); assert.equal(queue.get(task.id).status, 'delivered');
  await service.complete(task.id, task.lease!, { text: 'reply' }); await idle(service);
  assert.equal(attempts.length, 2); service.stop(); queue.close();
});

test('privacy and revocation block worker claims, attachments and reply delivery', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite')); let allowed = true;
  const service = new WorkerService(queue, join(dir, 'files'), 100, {
    allowed: async () => allowed, receive: async () => { allowed = false; return undefined; },
    prepare: async () => assert.fail('Private data must not be sent'), send: async () => assert.fail('No send'), report: () => {},
  });
  const task = queue.enqueue('!dm:test', event(), 'c');
  allowed = false; assert.equal(await service.claim(), null); assert.equal(queue.get(task.id).status, 'cancelled');
  allowed = true; queue.enqueue('!dm:test', event('$two'), 'c');
  const next = (await service.claim())!;
  await assert.rejects(service.attachment(next.id, next.lease!), /privacy changed/);
  await assert.rejects(service.complete(next.id, next.lease!, { text: 'secret' }), /privacy changed/);
  service.stop(); queue.close();
});

test('Grok room messages are durable and reset changes conversation identity while cancelling old leases', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const service = new WorkerService(queue, join(dir, 'files'), 100, { allowed: async () => true, receive: async () => undefined,
    prepare: async () => [], send: async () => {}, report: () => {} });
  const replies: string[] = [];
  const bridge = new WorkerBridge({ botId: '@grok:test', authorized: sender => sender === '@alice:test', privateRoom: async () => true,
    queue, service, state: new State(join(dir, 'state.json')), reply: async (_room, _event, text) => { replies.push(text); } });
  await bridge.handle('!dm:test', event()); await bridge.handle('!dm:test', event());
  const a = (await service.claim())!;
  await bridge.handle('!dm:test', { ...event('$other'), sender: '@stranger:test' });
  await bridge.handle('!dm:test', event('$reset', '!reset'));
  assert.equal(queue.get(a.id).status, 'cancelled');
  await bridge.handle('!dm:test', event('$next'));
  const b = (await service.claim())!; assert.notEqual(a.conversation, b.conversation);
  assert.equal(queue.list().some(task => task.event.sender === '@stranger:test'), false);
  assert.equal(replies.length, 1); bridge.stop(); queue.close();
});

test('worker sync checkpoints only after inbox commit and retains the old checkpoint on failure', async t => {
  for (const fail of [false, true]) for (const reaction of [false, true]) {
    const file = join(directory(t), 'matrix.json'), storage = new SimpleFsStorageProvider(file);
    storage.setSyncToken('previous');
    class Client extends WorkerMatrixClient {
      run() { return this.startSyncInternal(); }
      protected override async doSync() { return { next_batch: 'next' }; }
      protected override async processSync(_raw: any, emit: any) { await emit(reaction ? 'room.event' : 'room.message', '!dm:test', reaction ? { ...event(), type: 'm.reaction' } : event()); this.stop(); }
    }
    const client = new Client('https://matrix.test', 'synthetic-token', storage);
    let fatal = false; client.on('worker.inbox_failure', () => { fatal = true; });
    client.inbox = async () => {
      assert.equal(storage.getSyncToken(), 'previous');
      if (fail) throw new Error('disk unavailable');
    };
    await client.run();
    // The SDK starts its sync loop in the background. Let the first batch finish.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fatal, fail); assert.equal(storage.getSyncToken(), fail ? 'previous' : 'next');
  }
});

test('Grok provisioning syntax and disabled-by-default worker port are explicit', () => {
  assert.deepEqual(parseManagerRequest('create a Grok bot called Research'), { action: 'create', kind: 'grok', name: 'Research' });
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).workerPort, 0);
  assert.equal(loadConfig({ ...env, WORKER_PORT: '8788' }).workerPort, 8788);
  assert.throws(() => loadConfig({ ...env, WORKER_PORT: '65536' }), /WORKER_PORT/);
});

test('worker file replies store bytes under controlled names and never accept connector file paths', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  let preparedFile = '';
  const service = new WorkerService(queue, join(dir, 'files'), 100, { allowed: async () => true, receive: async () => undefined,
    prepare: async task => { preparedFile = task.response!.files[0].path; return [{ ciphertext: 'attachment' }]; }, send: async () => {}, report: () => {} });
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  await assert.rejects(service.complete(task.id, task.lease!, { files: [{ name: 'secrets', path: '/etc/passwd' }] }), /base64/);
  await service.complete(task.id, task.lease!, { files: [{ name: '../report.txt', data: Buffer.from('report').toString('base64') }] });
  await idle(service);
  assert.equal(queue.get(task.id).response!.files[0].name, 'report.txt');
  assert.equal(readFileSync(preparedFile, 'utf8'), 'report'); assert.ok(preparedFile.startsWith(join(dir, 'files') + '/'));
  assert.equal(queue.get(task.id).status, 'delivered'); service.stop(); queue.close();
});

test('cancellation during reply preparation prevents delivery and stale leases cannot access attachments', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  let service: WorkerService;
  service = new WorkerService(queue, join(dir, 'files'), 100, { allowed: async () => true,
    receive: async () => assert.fail('Cancelled attachment must not be read'),
    prepare: async task => { queue.cancel(task.id); return [{ ciphertext: 'cancelled' }]; },
    send: async () => assert.fail('Cancelled reply must not be sent'), report: () => {} });
  const task = queue.claim(queue.enqueue('!dm:test', event(), 'c').id)!;
  await service.complete(task.id, task.lease!, { text: 'reply' }); await idle(service);
  assert.equal(queue.get(task.id).status, 'cancelled');
  await assert.rejects(service.attachment(task.id, task.lease!), /cancelled/);
  service.stop(); queue.close();
});

test('worker status reports only this conversation queue and does not claim model knowledge', async t => {
  const dir = directory(t), queue = new WorkerQueue(join(dir, 'queue.sqlite'));
  const service = new WorkerService(queue, join(dir, 'files'), 100, { allowed: async () => true, receive: async () => undefined,
    prepare: async () => [], send: async () => {}, report: () => {} });
  t.after(() => { service.stop(); queue.close(); });
  const replies: string[] = [];
  const bridge = new WorkerBridge({ botId: '@grok:test', authorized: sender => sender === '@alice:test', privateRoom: async () => true,
    queue, service, state: new State(join(dir, 'state.json')), reply: async (_room, _event, text) => { replies.push(text); } });
  await bridge.handle('!dm:test', event('$work'));
  await bridge.handle('!elsewhere:test', event('$elsewhere'));
  await bridge.handle('!dm:test', event('$status', '!status'));
  assert.match(replies.at(-1)!, /Queued: 1/);
  assert.match(replies.at(-1)!, /not reported to Riftjack/);
  const leased = (await service.claim())!;
  await bridge.handle('!dm:test', event('$status2', '!status'));
  assert.match(replies.at(-1)!, /Queued: 0.*Leased to a worker: 1/);
  assert.equal(queue.get(leased.id).status, 'leased');
  await bridge.handle('!dm:test', event('$status2', '!status'));
  await bridge.handle('!dm:test', { ...event('$denied', '!status'), sender: '@stranger:test' });
  assert.equal(replies.length, 2);
});
