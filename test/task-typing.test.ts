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


test('a message during an in-flight renewal schedules one serialized refresh', async () => {
  const calls: boolean[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const typing = taskTyping(async value => { calls.push(value); if (calls.length === 1) await pending; },
    async () => true, error => { throw error; }, new AbortController().signal);
  await flush();
  typing.refresh(); typing.refresh();
  assert.deepEqual(calls, [true]);
  release(); await flush();
  assert.deepEqual(calls, [true, true]);
  await typing.close(); typing.refresh(); await flush();
  assert.deepEqual(calls, [true, true, false]);
});

test('cancellation discards a refresh requested while a send was in flight', async () => {
  const calls: boolean[] = [], controller = new AbortController();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const typing = taskTyping(async value => { calls.push(value); if (value) await pending; },
    async () => true, error => { throw error; }, controller.signal);
  await flush(); typing.refresh(); controller.abort();
  release(); await typing.close();
  assert.deepEqual(calls, [true, false]);
});
