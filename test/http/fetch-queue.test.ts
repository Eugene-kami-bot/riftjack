import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFetchMcp } from '../../src/fetch-mcp.js';
import { startToolMcp, type ToolConnection } from '../../src/tool-mcp.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function rpc(server: ToolConnection, id: number | undefined, method: string, params: unknown, signal?: AbortSignal) {
  const response = await fetch(server.url, { method: 'POST', signal, headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return response.status === 202 ? undefined : response.json();
}
const call = (server: ToolConnection, id: number, signal?: AbortSignal) => rpc(server, id, 'tools/call', { name: 'fetch', arguments: id }, signal);
const cancel = (server: ToolConnection, id: number) => rpc(server, undefined, 'notifications/cancelled', { requestId: id });

// With the active action held, the duplicate rejection proves this ID has been
// admitted, without a sleep or exposing the server's internal queue to tests.
async function enqueue(server: ToolConnection, id: number, signal?: AbortSignal) {
  const a = call(server, id, signal), b = call(server, id, signal);
  assert.match((await Promise.race([a, b])).error.message, /ID already used/);
  return { result: Promise.all([a, b]).then(results => results.find(r => r.result !== undefined)!) };
}

test('fetch queues calls in FIFO order, preserves results and continues after an action fails', { timeout: 10_000 }, async t => {
  const started = deferred(), gate = deferred();
  const order: number[] = [];
  const server = await startFetchMcp(async input => {
    const id = input as number; order.push(id);
    if (id === 1) { started.resolve(); await gate.promise; }
    if (id === 2) throw new Error('test failure');
    return String(id);
  }, new AbortController().signal);
  t.after(() => { gate.resolve(); return server.close(); });
  const first = call(server, 1); await started.promise;
  const second = await enqueue(server, 2), third = await enqueue(server, 3);
  assert.deepEqual(order, [1]);
  gate.resolve();
  const results = await Promise.all([first, second.result, third.result]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results.map(r => r.id), [1, 2, 3]);
  assert.equal(results[0].result.content[0].text, '1');
  assert.equal(results[1].result.isError, true);
  assert.equal(results[2].result.content[0].text, '3');
});

test('fetch queue is bounded and cancelling a waiting call frees capacity without executing it', { timeout: 10_000 }, async t => {
  const started = deferred(), gate = deferred();
  const order: number[] = [];
  const server = await startFetchMcp(async input => {
    order.push(input as number);
    if (input === 1) { started.resolve(); await gate.promise; }
    return String(input);
  }, new AbortController().signal);
  t.after(() => { gate.resolve(); return server.close(); });
  const first = call(server, 1); await started.promise;
  const queued = [];
  for (let id = 2; id <= 51; id++) queued.push(await enqueue(server, id));
  assert.match((await call(server, 52)).error.message, /queue is full/);
  await cancel(server, 2);
  assert.equal((await queued[0].result).result.content[0].text, 'Fetch cancelled.');
  const last = await enqueue(server, 52);
  assert.deepEqual(order, [1]);
  gate.resolve();
  await Promise.all([first, ...queued.map(q => q.result), last.result]);
  assert.deepEqual(order, [1, ...Array.from({ length: 50 }, (_, i) => i + 3)]);
});

for (const reason of ['notification', 'disconnect', 'task', 'close'] as const) test(`fetch ${reason} cancellation releases active and queued calls`, { timeout: 10_000 }, async t => {
  const started = deferred(), task = new AbortController(), connection = new AbortController();
  const order: number[] = [];
  const server = await startFetchMcp(async (input, signal) => {
    order.push(input as number);
    if (input === 1) {
      started.resolve();
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return String(input);
  }, task.signal);
  t.after(() => server.close());
  // Closing the server may close the socket before the cancellation response.
  const first = call(server, 1, connection.signal).catch(() => undefined); await started.promise;
  const second = await enqueue(server, 2);
  const secondResult = second.result.catch(() => undefined);
  if (reason === 'notification') await cancel(server, 1);
  else if (reason === 'disconnect') connection.abort();
  else if (reason === 'task') task.abort();
  else await server.close();
  const results = await Promise.all([first, secondResult]);
  if (reason === 'notification' || reason === 'disconnect') {
    if (reason === 'notification') assert.equal(results[0].result.content[0].text, 'Fetch cancelled.');
    assert.equal(results[1].result.content[0].text, '2');
    assert.deepEqual(order, [1, 2]);
  } else {
    await server.close();
    assert.deepEqual(order, [1]);
  }
});

test('fetch endpoints have independent queues and other tools still reject concurrent calls', { timeout: 10_000 }, async t => {
  const started = deferred(), gate = deferred();
  const a = await startFetchMcp(async () => { started.resolve(); await gate.promise; return 'a'; }, new AbortController().signal);
  const b = await startFetchMcp(async () => 'b', new AbortController().signal);
  const c = await startToolMcp({ name: 'fetch', description: '', inputSchema: {}, annotations: {} },
    async () => { await gate.promise; return 'c'; }, new AbortController().signal,
    { server: 'other-tool', cancelled: 'cancelled', failed: 'failed' });
  t.after(async () => { gate.resolve(); await Promise.all([a.close(), b.close(), c.close()]); });
  const first = call(a, 1); await started.promise;
  const pending = await enqueue(c, 1);
  assert.match((await call(c, 2)).error.message, /already pending/);
  assert.equal((await call(b, 1)).result.content[0].text, 'b');
  gate.resolve(); await Promise.all([first, pending.result]);
});


test('disconnecting a queued fetch skips its action', { timeout: 10_000 }, async t => {
  const started = deferred(), gate = deferred(), connection = new AbortController();
  const order: number[] = [];
  const server = await startFetchMcp(async input => {
    order.push(input as number);
    if (input === 1) { started.resolve(); await gate.promise; }
    return String(input);
  }, new AbortController().signal);
  t.after(() => { gate.resolve(); return server.close(); });
  const first = call(server, 1); await started.promise;
  const second = await enqueue(server, 2, connection.signal);
  const cancelled = assert.rejects(second.result);
  connection.abort(); await cancelled;
  // A ping keeps the server responsive while the first action is still held.
  await rpc(server, 3, 'ping', {});
  gate.resolve(); await first;
  assert.equal((await call(server, 4)).result.content[0].text, '4');
  assert.deepEqual(order, [1, 4]);
});
