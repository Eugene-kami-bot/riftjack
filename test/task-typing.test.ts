import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskTyping } from '../src/task-typing.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('typing renews with expiry, clears once and stops its timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls: [boolean, number][] = [];
  const { close } = taskTyping(async (typing, timeout) => { calls.push([typing, timeout]); }, async () => true,
    error => { throw error; }, new AbortController().signal);
  await flush();
  assert.deepEqual(calls, [[true, 30_000]]);
  t.mock.timers.tick(15_000); await flush();
  assert.deepEqual(calls, [[true, 30_000], [true, 30_000]]);
  await close(); await close();
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(calls.map(c => c[0]), [true, true, false]);
});

test('abort serializes cleanup after an in-flight send without accumulating renewals', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController(), calls: boolean[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { close } = taskTyping(async typing => { calls.push(typing); if (typing) await pending; }, async () => true,
    error => { throw error; }, controller.signal);
  await flush();
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(calls, [true]);
  controller.abort();
  release(); await close();
  assert.deepEqual(calls, [true, false]);
  t.mock.timers.tick(60_000); await flush();
  assert.deepEqual(calls, [true, false]);
});

test('late authorization cannot renew after cancellation; denied destinations receive no updates', async () => {
  const controller = new AbortController(), calls: boolean[] = [];
  let release!: (allowed: boolean) => void, first = true;
  const { close } = taskTyping(async typing => { calls.push(typing); }, async () => {
    if (!first) return false;
    first = false;
    return new Promise<boolean>(resolve => { release = resolve; });
  }, error => { throw error; }, controller.signal);
  controller.abort(); release(true); await close();
  assert.deepEqual(calls, []);
});

test('typing failures are reported and cleanup still attempts a clear', async () => {
  const errors: unknown[] = [], calls: boolean[] = [];
  const { close } = taskTyping(async typing => { calls.push(typing); throw new Error('offline'); }, async () => true,
    error => errors.push(error), new AbortController().signal);
  await flush(); await close();
  assert.deepEqual(calls, [true, false]);
  assert.equal(errors.length, 2);
});


test('a message waits for an in-flight renewal and restores typing 250 ms after delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const events: (boolean | string)[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const typing = taskTyping(async value => { events.push(value); if (events.length === 1) await pending; },
    async () => true, error => { throw error; }, new AbortController().signal);
  await flush();
  const delivery = typing.message(async () => { events.push('message'); });
  await flush(); assert.deepEqual(events, [true]);
  release(); await delivery;
  assert.deepEqual(events, [true, false, 'message']);
  t.mock.timers.tick(249); await flush();
  assert.deepEqual(events, [true, false, 'message']);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(events, [true, false, 'message', true]);
  await typing.close();
});

test('renewals stay paused until all overlapping deliveries finish, with a fresh delay after the last one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [];
  const typing = taskTyping(async value => { calls.push(value); }, async () => true,
    error => { throw error; }, new AbortController().signal);
  await flush();
  let first!: () => void, second!: () => void;
  const a = typing.message(() => new Promise<void>(resolve => { first = resolve; }));
  const b = typing.message(() => new Promise<void>(resolve => { second = resolve; }));
  await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.deepEqual(calls, [true, false, false]);
  first(); await a;
  t.mock.timers.tick(250); await flush();
  assert.deepEqual(calls, [true, false, false]);
  second(); await b;
  t.mock.timers.tick(249); await flush();
  assert.deepEqual(calls, [true, false, false]);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.at(-1), true);
  await typing.close();
});

for (const stop of ['cancel', 'close', 'access revoked'] as const) test(`a delayed restore cannot turn typing on after ${stop}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [], controller = new AbortController();
  let allowed = true;
  const typing = taskTyping(async value => { calls.push(value); }, async () => allowed,
    error => { throw error; }, controller.signal);
  await flush(); await typing.message(async () => {});
  assert.deepEqual(calls, [true, false]);
  if (stop === 'cancel') controller.abort();
  else if (stop === 'close') await typing.close();
  else allowed = false;
  t.mock.timers.tick(30_000); await flush();
  assert.equal(calls.filter(Boolean).length, 1);
  await typing.close();
});

test('a subsequent message resets the restore delay and delivery errors retain their cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [], failure = new Error('delivery failed');
  const typing = taskTyping(async value => { calls.push(value); }, async () => true,
    error => { throw error; }, new AbortController().signal);
  await flush(); await typing.message(async () => {});
  t.mock.timers.tick(200); await flush();
  await assert.rejects(typing.message(async () => { throw failure; }), error => error === failure);
  t.mock.timers.tick(50); await flush();
  assert.deepEqual(calls, [true, false, false]);
  t.mock.timers.tick(200); await flush();
  assert.equal(calls.at(-1), true);
  await typing.close();
});

test('cancellation during the pre-message clear prevents a stale delivery and any restore', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: boolean[] = [], controller = new AbortController();
  let release!: () => void, delivered = false;
  const clearing = new Promise<void>(resolve => { release = resolve; });
  const typing = taskTyping(async value => { calls.push(value); if (!value) await clearing; },
    async () => true, error => { throw error; }, controller.signal);
  await flush();
  const delivery = typing.message(async () => { delivered = true; });
  await flush(); controller.abort();
  const rejected = assert.rejects(delivery, { name: 'AbortError' });
  release(); await rejected; await typing.close();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(delivered, false);
  assert.equal(calls.filter(Boolean).length, 1);
});
