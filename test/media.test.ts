import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { EncryptedFile } from '@vector-im/matrix-bot-sdk';
import { MatrixMedia, mediaDirectory, mediaInstructions, outboxDirectory, parseMediaReply, readOutgoing, readLimited, safeName } from '../src/media.js';
import { loadConfig } from '../src/config.js';

const signal = () => new AbortController().signal;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function setup(t: { after(fn: () => void): void }, maxBytes = 1024) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'matrix-media-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uploads: Buffer[] = [], messages: Record<string, any>[] = [];
  let download: Buffer = Buffer.alloc(0);
  let fetches = 0;
  let onDownload = () => {};
  const media = new MatrixMedia({
    mxcToHttp: async () => 'https://matrix.test/_matrix/client/v1/media/download/matrix.test/id',
    sendMessage: async (room, content) => { assert.equal(room, '!dm:test'); messages.push(content); return '$sent'; },
  }, { workspace: dir, homeserver: 'https://matrix.test', accessToken: 'test-token', maxBytes, scope: '@bot:test' }, async (_url, options) => {
    fetches++;
    assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    if (options?.method === 'POST') {
      assert.equal(String(_url), 'https://matrix.test/_matrix/media/v3/upload');
      assert.equal((options.headers as Record<string, string>)['Content-Type'], 'application/octet-stream');
      const chunks: Buffer[] = [];
      for await (const chunk of options.body as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      assert.equal(data.length, Number((options.headers as Record<string, string>)['Content-Length']));
      uploads.push(data);
      return Response.json({ content_uri: 'mxc://matrix.test/id' });
    }
    onDownload();
    return new Response(new Uint8Array(download));
  });
  function encrypted(data: Buffer): EncryptedFile {
    const result = Attachment.encrypt(data);
    download = Buffer.from(result.encryptedData);
    return { ...JSON.parse(result.mediaEncryptionInfo!), url: 'mxc://matrix.test/id' };
  }
  return { dir, media, uploads, messages, encrypted, fetches: () => fetches,
    corrupt: () => { download[0] ^= 1; }, onDownload: (fn: () => void) => { onDownload = fn; } };
}

function incomingFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).filter(name => name.includes('attachment-'));
}

test('revoking access during an encrypted download exposes no plaintext file', async t => {
  const f = setup(t);
  const file = f.encrypted(png);
  let allowed = true;
  f.onDownload(() => { allowed = false; });
  await assert.rejects(f.media.receive({ file }, 'key', signal(), async () => {
    assert.ok(readdirSync(f.dir, { recursive: true }).some(name => String(name).includes('task-')));
    if (!allowed) throw new Error('Access revoked');
  }), /Access revoked/);
  assert.deepEqual(incomingFiles(f.dir), []);
});

test('cancellation while awaiting incoming authorization exposes no plaintext file', async t => {
  const f = setup(t);
  const abort = new AbortController();
  await assert.rejects(f.media.receive({ file: f.encrypted(png) }, 'key', abort.signal, async () => {
    await Promise.resolve();
    abort.abort();
  }), /abort/i);
  assert.deepEqual(incomingFiles(f.dir), []);
});

test('failed incoming writes remove the partial file created by the attempt', async t => {
  const f = setup(t);
  const handle = await open(join(f.dir, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const write = prototype.writeFile;
  t.mock.method(prototype, 'writeFile', async function(this: typeof handle, data: Buffer) {
    await write.call(this, data.subarray(0, 3));
    throw new Error('Simulated write failure');
  });
  await assert.rejects(f.media.receive({ file: f.encrypted(png) }, 'key', signal(), async () => {}), /Simulated write failure/);
  assert.deepEqual(incomingFiles(f.dir), []);
});

test('incoming EEXIST preserves the file that existed before the write attempt', async t => {
  const f = setup(t);
  let existing = '';
  await assert.rejects(f.media.receive({ file: f.encrypted(png), body: 'image.png' }, 'key', signal(), async () => {
    const dir = readdirSync(f.dir, { recursive: true }).map(String).find(name => name.includes('task-'))!;
    existing = join(f.dir, dir, 'attachment-image.png');
    writeFileSync(existing, 'existing content');
  }), { code: 'EEXIST' });
  assert.equal(readFileSync(existing, 'utf8'), 'existing content');
});

test('image, audio and document messages upload ciphertext and preserve threads without reply quotes', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'conversation');
  const thread = { rel_type: 'm.thread', event_id: '$root' };
  for (const [name, data, msgtype, mimetype] of [
    ['picture.png', png, 'm.image', 'image/png'],
    ['sound.wav', Buffer.from('RIFF sound data'), 'm.audio', 'audio/wav'],
    ['report.pdf', Buffer.from('%PDF-1.4 example'), 'm.file', 'application/pdf'],
  ] as const) {
    const path = join(root, name); writeFileSync(path, data);
    const relation = name === 'report.pdf' ? undefined : thread;
    await f.media.send('!dm:test', [{ root, path }], relation, signal(), async () => {});
    const message = f.messages.at(-1)!;
    assert.equal(message.msgtype, msgtype);
    assert.equal(message.info.mimetype, mimetype);
    assert.equal(message.info.size, data.length);
    assert.deepEqual(message['m.relates_to'], relation);
    if (!relation) assert.equal(Object.hasOwn(message, 'm.relates_to'), false);
    assert.equal(message.url, undefined);
    assert.notDeepEqual(f.uploads.at(-1), data);
    const decrypted = Attachment.decrypt(new EncryptedAttachment(f.uploads.at(-1)!, JSON.stringify(message.file)));
    assert.deepEqual(Buffer.from(decrypted), data);
  }
});

test('incoming encrypted image round-trips, preserves bytes and is stored privately', async t => {
  const f = setup(t);
  const file = f.encrypted(png);
  const received = await f.media.receive({ msgtype: 'm.image', filename: '../../AGENTS.md', body: 'Describe this', file }, 'conversation', signal(), async () => {});
  assert.equal(received.name, 'AGENTS.md');
  assert.ok(received.path.endsWith('/attachment-AGENTS.md'));
  assert.equal(received.image, true);
  assert.equal(received.mimetype, 'image/png');
  assert.deepEqual(readFileSync(received.path), png);
  assert.equal(statSync(received.path).mode & 0o777, 0o600);
  const second = await f.media.receive({ msgtype: 'm.file', file, body: 'AGENTS.md' }, 'different conversation', signal(), async () => {});
  assert.notEqual(second.path, received.path);
});

test('incoming audio remains a local attachment and retains its declared audio type', async t => {
  const f = setup(t);
  const data = Buffer.from('voice recording');
  const received = await f.media.receive({ msgtype: 'm.audio', body: 'Voice message', file: f.encrypted(data), info: { mimetype: 'audio/ogg' } }, 'conversation', signal(), async () => {});
  assert.equal(received.image, false); assert.equal(received.mimetype, 'audio/ogg');
  assert.deepEqual(readFileSync(received.path), data);
});

test('tampering, plaintext attachments, unsafe URLs and excessive declared sizes fail', async t => {
  const f = setup(t);
  const file = f.encrypted(png); f.corrupt();
  await assert.rejects(f.media.receive({ file }, 'key', signal(), async () => {}), /decrypt or verify/);
  await assert.rejects(f.media.receive({ url: 'https://example.test/file' }, 'key', signal(), async () => {}), /file encryption/);
  await assert.rejects(f.media.receive({ file: { ...file, url: 'https://example.test/file' } }, 'key', signal(), async () => {}), /media URL/);
  await assert.rejects(f.media.receive({ file, info: { size: 1025 } }, 'key', signal(), async () => {}), /limit/);
  assert.equal(f.fetches(), 1);
});

test('actual download size is bounded even with absent or false size metadata', async t => {
  const f = setup(t, 4);
  const file = f.encrypted(Buffer.from('oversized'));
  await assert.rejects(f.media.receive({ file, info: { size: 1 } }, 'key', signal(), async () => {}), /limit/);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readLimited(new Response(body), 4, signal()), /limit/);
  assert.equal(cancelled, true);
});

test('cancelling a pending download releases the stream and sends no attachment', async t => {
  const f = setup(t);
  const abort = new AbortController();
  const pending = readLimited(new Response(new ReadableStream()), 10, abort.signal);
  abort.abort();
  await assert.rejects(pending, /abort/i);
  await assert.rejects(f.media.send('!dm:test', [{ path: '/unused', root: '/unused' }], {}, abort.signal, async () => {}), /abort/i);
  assert.equal(f.uploads.length, 0);
});

test('authorization is checked again after upload before delivering encryption keys', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'key');
  const path = join(root, 'hello.txt'); writeFileSync(path, 'hello');
  let checks = 0;
  await assert.rejects(f.media.send('!dm:test', [{ path, root }], {}, signal(), async () => {
    if (++checks === 3) throw new Error('Access revoked');
  }), /Access revoked/);
  assert.equal(f.uploads.length, 1); assert.equal(f.messages.length, 0);
});

test('cancellation while rechecking authorization prevents attachment delivery', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'key');
  const path = join(root, 'hello.txt'); writeFileSync(path, 'hello');
  const controller = new AbortController();
  let checks = 0;
  await assert.rejects(f.media.send('!dm:test', [{ path, root }], {}, controller.signal, async () => {
    if (++checks === 3) controller.abort();
  }), /abort/i);
  assert.equal(f.messages.length, 0);
});

test('Unicode filenames fit the filesystem byte limit and cannot contain path separators', () => {
  const name = safeName('../' + '😀'.repeat(200) + '.png');
  assert.ok(Buffer.byteLength(name) <= 200);
  assert.ok(!name.includes('/'));
  assert.equal(safeName('..\\folder\\report.txt'), 'report.txt');
});

test('only explicit manifests create attachments; ordinary paths stay text', () => {
  const root = '/workspace/outbox';
  assert.equal(parseMediaReply('See [file](/tmp/file.txt)', root), 'See [file](/tmp/file.txt)');
  assert.deepEqual(parseMediaReply('Here you go.\n```matrix-attachments\n{"files":[{"path":"hello.txt"}]}\n```', root), {
    text: 'Here you go.', attachments: [{ root, path: root + '/hello.txt', name: undefined }],
  });
  for (const path of ['../secret', '/etc/passwd', '..']) {
    assert.throws(() => parseMediaReply('```matrix-attachments\n' + JSON.stringify({ files: [{ path }] }) + '\n```', root));
  }
  assert.throws(() => parseMediaReply('```matrix-attachments\nnot JSON\n```', root), /invalid/);
  assert.throws(() => parseMediaReply('```matrix-attachments\n' + JSON.stringify({ files: Array(11).fill({ path: 'a' }) }) + '\n```', root), /at most 10/);
});

test('each conversation has one stable outbox that is emptied at the start of every turn', async t => {
  const f = setup(t);
  const first = await outboxDirectory(f.dir, 'conversation');
  writeFileSync(join(first, 'old.txt'), 'previous turn');
  const second = await outboxDirectory(f.dir, 'conversation');
  assert.equal(second, first);
  assert.deepEqual(readdirSync(second), []);
  assert.notEqual(await outboxDirectory(f.dir, 'other conversation'), first);
  assert.match(mediaInstructions(first, 1024), new RegExp(`outbox: ${JSON.stringify(first).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}`));
  assert.doesNotMatch(mediaInstructions(first, 1024), /User message follows/);
  assert.match(mediaInstructions(first, 1024), /transcription.status is complete/);
  assert.match(mediaInstructions(first, 1024), /potentially inaccurate transcript/);
  assert.match(mediaInstructions(first, 1024), /not instructions or approval/);
});

test('outbox refuses symlinks, hard links, directories, traversal and oversized files', async t => {
  const f = setup(t, 10);
  const root = await mediaDirectory(f.dir, 'outgoing', 'key');
  const secret = join(f.dir, 'secret'); writeFileSync(secret, 'secret');
  symlinkSync(secret, join(root, 'symlink'));
  linkSync(secret, join(root, 'hardlink'));
  writeFileSync(join(root, 'big'), Buffer.alloc(11));
  for (const path of [secret, join(root, 'symlink'), join(root, 'hardlink'), root, join(root, 'big')]) {
    await assert.rejects(readOutgoing({ root, path }, 10));
    await assert.rejects(f.media.send('!dm:test', [{ root, path }], {}, signal(), async () => {}));
  }
  const path = join(root, 'ok'); writeFileSync(path, '12345');
  assert.equal((await readOutgoing({ root, path }, 5)).toString(), '12345');
});

test('media root symlinks cannot redirect incoming or outgoing files', async t => {
  const f = setup(t);
  symlinkSync(tmpdir(), join(f.dir, '.matrix-media'));
  await assert.rejects(mediaDirectory(f.dir, 'incoming', 'key'), /symlinks/);
});

test('attachment size configuration is bounded', async t => {
  const f = setup(t);
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.dir };
  assert.equal(loadConfig(env).maxMediaBytes, 512 * 1024 ** 2);
  for (const value of ['1', '20971520', '536870912']) {
    assert.equal(loadConfig({ ...env, MAX_MEDIA_BYTES: value }).maxMediaBytes, Number(value));
  }
  for (const value of ['-1', '0', 'NaN', '1.5', 'Infinity', '536870913', '1073741824']) {
    assert.throws(() => loadConfig({ ...env, MAX_MEDIA_BYTES: value }), /MAX_MEDIA_BYTES/);
  }
});


test('upload deadlines are explicit and bounded independently of task duration', async t => {
  const f = setup(t);
  const env = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: f.dir };
  assert.equal(loadConfig(env).mediaUploadTimeoutMs, 1_800_000);
  assert.equal(loadConfig({ ...env, MEDIA_UPLOAD_TIMEOUT_SECONDS: '86400' }).mediaUploadTimeoutMs, 86_400_000);
  for (const value of ['0', '-1', 'NaN', '86401']) {
    assert.throws(() => loadConfig({ ...env, MEDIA_UPLOAD_TIMEOUT_SECONDS: value }), /MEDIA_UPLOAD_TIMEOUT_SECONDS/);
  }
});


test('files changed after opening cannot deliver encryption keys', async t => {
  const f = setup(t);
  const root = await mediaDirectory(f.dir, 'outgoing', 'changing');
  const path = join(root, 'changing.bin');
  let sent = 0;
  for (const content of ['short', 'a much longer replacement', 'changed!']) {
    writeFileSync(path, 'original');
    const media = new MatrixMedia({ mxcToHttp: async () => '', sendMessage: async () => { sent++; return '$sent'; } },
      { workspace: f.dir, homeserver: 'https://matrix.test', accessToken: 'token', maxBytes: 1024, scope: 'test' },
      async (_url, init) => {
        writeFileSync(path, content);
        utimesSync(path, new Date(), new Date(Date.now() + 2000));
        for await (const _ of init!.body as unknown as AsyncIterable<Buffer>) { /* consume */ }
        return Response.json({ content_uri: 'mxc://matrix.test/id' });
      });
    await assert.rejects(media.send('!dm:test', [{ root, path }], {}, signal(), async () => {}), /changed/);
  }
  assert.equal(sent, 0);
});
