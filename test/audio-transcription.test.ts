import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AudioTranscriber, loadAudioConfig } from '../src/audio-transcription.js';
import { configForWorkspace } from '../src/workspace.js';
import { loadConfig } from '../src/config.js';
import { spawnSync } from 'node:child_process';
import { AudioConfigurationWarnings } from '../src/audio-notice.js';

function fixture(t: { after(fn: () => void): void }, engine = '', decoder = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'audio-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2);\n${body}`, { mode: 0o700 });
    return path;
  };
  const ffmpeg = script('decoder.cjs', decoder || `
    if (args[args.indexOf('-protocol_whitelist')+1] !== 'pipe') process.exit(2);
    process.stdin.resume(); process.stdin.on('end', () => process.stdout.end(Buffer.alloc(3200)));`);
  const executable = script('engine.cjs', engine || `
    const wav = fs.readFileSync(args.at(-1));
    if (wav.toString('ascii',0,4)!=='RIFF' || wav.readUInt32LE(24)!==16000 || wav.readUInt16LE(22)!==1) process.exit(2);
    if (process.env.AUDIO_TEST_SECRET) process.exit(3);
    fs.writeFileSync(args[args.indexOf('-o')+1], 'Пример распознанной речи.');`);
  const model = join(root, 'model.gguf'); writeFileSync(model, 'synthetic model');
  const path = join(root, 'voice.ogg'); writeFileSync(path, 'synthetic audio');
  const file = { path, name: 'voice.ogg', size: 15, mimetype: 'audio/ogg', image: false };
  const config = { model, ffmpeg, executable, maxSeconds: 1, timeoutMs: 5000 };
  return { root, file, config, transcriber: new AudioTranscriber(config) };
}
const signal = () => new AbortController().signal;

test('bad optional audio configuration leaves ordinary connector configuration usable', t => {
  const f = fixture(t);
  const base = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: process.cwd() };
  for (const patch of [
    { AUDIO_TRANSCRIBE_MODEL: join(f.root, 'missing-model') },
    { AUDIO_TRANSCRIBE_MODEL: f.config.model, AUDIO_TRANSCRIBE_PATH: join(f.root, 'missing-cli') },
    { AUDIO_TRANSCRIBE_MODEL: f.config.model, AUDIO_TRANSCRIBE_PATH: f.config.executable, AUDIO_FFMPEG_PATH: join(f.root, 'missing-ffmpeg') },
    { AUDIO_TRANSCRIBE_MODEL: f.config.model, AUDIO_TRANSCRIBE_PATH: f.config.executable, AUDIO_FFMPEG_PATH: f.config.ffmpeg, AUDIO_MAX_SECONDS: '0' },
  ]) {
    const config = loadConfig({ ...base, ...patch });
    assert.equal(config.audioTranscription, undefined);
    assert.match(config.audioTranscriptionWarning!, /disabled/);
    assert.equal(config.owner, base.MATRIX_OWNER_ID);
    assert.ok(!config.audioTranscriptionWarning!.includes(f.root));
  }
  const disabled = loadConfig({ ...base, AUDIO_TRANSCRIBE_PATH: '/missing', AUDIO_MAX_SECONDS: 'invalid' });
  assert.equal(disabled.audioTranscription, undefined);
  assert.equal(disabled.audioTranscriptionWarning, undefined);
  assert.throws(() => loadConfig({ ...base, MATRIX_OWNER_ID: 'invalid' }));
});

test('real configuration entry point warns but exits successfully for missing optional audio tools', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', '--check-config'], {
    env: { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: process.cwd(),
      AUDIO_TRANSCRIBE_MODEL: '/nonexistent-riftjack-test/model.gguf', PATH: '/nonexistent-riftjack-test' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Audio transcription is disabled/);
  assert.match(result.stdout, /Configuration is valid/);
});

test('audio warnings wait for an owner DM, deduplicate, and do not retry uncertain sends', async () => {
  const warnings = new AudioConfigurationWarnings(), sent: string[] = [];
  warnings.add('Missing optional model'); warnings.add('Missing optional model');
  const target = { allowed: async () => false, send: async (text: string) => { sent.push(text); } };
  await warnings.deliver([target]);
  assert.deepEqual(sent, []);
  await warnings.deliver([target, { ...target, allowed: async () => true }]);
  await warnings.deliver([{ ...target, allowed: async () => true }]);
  assert.deepEqual(sent, ['Missing optional model']);
  warnings.add('Missing decoder');
  let attempts = 0;
  const uncertain = { allowed: async () => true, send: async () => { ++attempts; throw new Error('lost receipt'); } };
  await assert.rejects(warnings.deliver([uncertain]), /lost receipt/);
  warnings.add('Missing decoder');
  await warnings.deliver([uncertain]);
  assert.equal(attempts, 1);
});

test('optional configuration validates trusted paths, bounds and custom bot workspaces', t => {
  const f = fixture(t), workspace = join(f.root, 'workspace');
  assert.equal(loadAudioConfig({}, workspace), undefined);
  const env = { AUDIO_TRANSCRIBE_MODEL: f.config.model, AUDIO_TRANSCRIBE_PATH: f.config.executable, AUDIO_FFMPEG_PATH: f.config.ffmpeg };
  assert.equal(loadAudioConfig(env, workspace)!.maxSeconds, 300);
  for (const patch of [{ AUDIO_TRANSCRIBE_MODEL: 'relative' }, { AUDIO_TRANSCRIBE_PATH: '' },
    { AUDIO_MAX_SECONDS: '0' }, { AUDIO_MAX_SECONDS: '1801' }, { AUDIO_TIMEOUT_SECONDS: '601' }]) {
    assert.throws(() => loadAudioConfig({ ...env, ...patch }, workspace));
  }
  assert.throws(() => loadAudioConfig(env, f.root), /outside/);
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: f.root });
  const isolated = configForWorkspace({ ...config, audioTranscription: f.config });
  assert.equal(isolated.audioTranscription, undefined);
  assert.match(isolated.audioTranscriptionWarning!, /outside/);
});

test('local audio becomes labelled automatic transcription without passing connector secrets', async t => {
  const f = fixture(t);
  const previous = process.env.AUDIO_TEST_SECRET;
  process.env.AUDIO_TEST_SECRET = 'must not reach child';
  t.after(() => { if (previous === undefined) delete process.env.AUDIO_TEST_SECRET; else process.env.AUDIO_TEST_SECRET = previous; });
  const result = await f.transcriber.transcribe(f.file, signal());
  assert.equal(result.path, f.file.path);
  assert.deepEqual(result.transcription, { status: 'complete', text: 'Пример распознанной речи.', automatic: true });
});

test('non-audio and oversized inputs do not invoke the recognizer', async t => {
  const f = fixture(t, 'throw Error("Must not run")');
  const document = { ...f.file, mimetype: 'application/pdf' };
  assert.equal(await f.transcriber.transcribe(document, signal()), document);
  assert.equal((await f.transcriber.transcribe({ ...f.file, size: 33 * 1024 * 1024 }, signal())).transcription?.status, 'unavailable');
});

test('unsafe audio paths and duration overruns keep the original attachment without partial text', async t => {
  const f = fixture(t, '', 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.end(Buffer.alloc(40000)));');
  assert.deepEqual((await f.transcriber.transcribe(f.file, signal())).transcription, { status: 'unavailable', reason: 'duration-limit' });
  const link = join(f.root, 'link.ogg'); symlinkSync(f.file.path, link);
  assert.deepEqual((await f.transcriber.transcribe({ ...f.file, path: link }, signal())).transcription, { status: 'unavailable', reason: 'processing-failed' });
});

for (const [name, body] of [
  ['failure', 'process.exit(7);'],
  ['oversized text', 'fs.writeFileSync(args[args.indexOf("-o")+1], "x".repeat(33000));'],
  ['timeout', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},100);'],
] as const) test(`${name} falls back to audio and cleans private temporary files`, async t => {
  const f = fixture(t);
  // Record only the temporary directory, not audio or transcript contents.
  writeFileSync(f.config.executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(join(f.root, 'temp-path'))},require('node:path').dirname(args.at(-1)));${body}`, { mode: 0o700 });
  const transcriber = new AudioTranscriber({ ...f.config, timeoutMs: name === 'timeout' ? 700 : 5000 });
  assert.equal((await transcriber.transcribe(f.file, signal())).transcription?.status, 'unavailable');
  // Under load the overall timeout may expire during decoding, before the engine starts.
  const marker = join(f.root, 'temp-path');
  if (name !== 'timeout' || existsSync(marker)) {
    const temporary = readFileSync(marker, 'utf8');
    assert.throws(() => readdirSync(temporary), { code: 'ENOENT' });
  }
});

test('busy skips a second file, cancellation kills the child and releases the slot', async t => {
  const f = fixture(t, 'setInterval(()=>{},100);');
  const abort = new AbortController();
  const first = f.transcriber.transcribe(f.file, abort.signal);
  assert.deepEqual((await f.transcriber.transcribe(f.file, signal())).transcription, { status: 'unavailable', reason: 'busy' });
  abort.abort();
  await assert.rejects(first, /abort/i);
  writeFileSync(f.config.executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('-o')+1],'ready');`, { mode: 0o700 });
  assert.equal((await f.transcriber.transcribe(f.file, signal())).transcription?.status, 'complete');
});
