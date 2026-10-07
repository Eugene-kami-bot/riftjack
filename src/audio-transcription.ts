import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readOutgoing, type IncomingAttachment } from './media.js';

export type AudioConfig = { model: string; executable: string; ffmpeg: string; maxSeconds: number; timeoutMs: number };
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;

export function audioOutsideWorkspace(config: AudioConfig, workspace: string): void {
  if ([config.model, config.executable, config.ffmpeg].some(path => path.startsWith(workspace + sep))) {
    throw new Error('Audio transcription files must be outside every agent workspace.');
  }
}

export function loadAudioConfig(env: NodeJS.ProcessEnv, workspace: string): AudioConfig | undefined {
  if (!env.AUDIO_TRANSCRIBE_MODEL?.trim()) return undefined;
  const file = (name: string, executable = false) => {
    const value = env[name]?.trim();
    if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
    try {
      const path = realpathSync(value);
      if (!statSync(path).isFile()) throw new Error('not a file');
      accessSync(path, executable ? constants.X_OK : constants.R_OK);
      return path;
    } catch {
      throw new Error(`${name} must point to an accessible ${executable ? 'executable' : 'readable'} regular file.`);
    }
  };
  const number = (name: string, fallback: number, maximum: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be between 1 and ${maximum}.`);
    return value;
  };
  const config = { model: file('AUDIO_TRANSCRIBE_MODEL'), executable: file('AUDIO_TRANSCRIBE_PATH', true),
    ffmpeg: file('AUDIO_FFMPEG_PATH', true), maxSeconds: number('AUDIO_MAX_SECONDS', 300, 1800),
    timeoutMs: number('AUDIO_TIMEOUT_SECONDS', 120, 600) * 1000 };
  audioOutsideWorkspace(config, workspace);
  return config;
}

// Invalid optional configuration must not prevent the connector from starting.
export function optionalAudioConfig(env: NodeJS.ProcessEnv, workspace: string): {
  audioTranscription?: AudioConfig; audioTranscriptionWarning?: string;
} {
  try { return { audioTranscription: loadAudioConfig(env, workspace) }; }
  catch (error) {
    return { audioTranscriptionWarning: `Audio transcription is disabled: ${(error as Error).message} Original audio attachments remain available. Fix the audio settings and restart to enable transcription.` };
  }
}

// No shell, no inherited connector credentials, and no input filenames from Matrix.
// Wait for exit before releasing the slot or removing private temporary files.
async function run(executable: string, args: string[], signal: AbortSignal, input?: Buffer, limit = 0): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0, failure: unknown, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: unknown) => {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', error => stop(error));
    child.stderr.resume(); // Never expose diagnostic output or audio content to logs.
    child.stdout.on('data', (data: Buffer) => {
      if (!limit || failure) return;
      size += data.length;
      if (size > limit) stop(new Error('Decoded audio exceeds the duration limit.'));
      else chunks.push(data);
    });
    child.once('close', code => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Audio subprocess failed.'));
      else resolve(Buffer.concat(chunks, size));
    });
    if (signal.aborted) abort();
    child.stdin.end(input);
  });
}

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class AudioTranscriber {
  private busy = false;
  constructor(private config: AudioConfig) {}

  async transcribe(file: IncomingAttachment, signal: AbortSignal): Promise<IncomingAttachment> {
    signal.throwIfAborted();
    if (file.image || !file.mimetype.startsWith('audio/')) return file;
    const unavailable = (reason: string): IncomingAttachment => ({ ...file, transcription: { status: 'unavailable', reason } });
    if (this.busy) return unavailable('busy');
    if (file.size > MAX_INPUT_BYTES) return unavailable('input-limit');
    this.busy = true;
    let directory: string | undefined;
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
      const input = await readOutgoing({ path: file.path, root: dirname(file.path) }, MAX_INPUT_BYTES);
      const pcm = await run(this.config.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0', '-ac', '1', '-ar', '16000',
        '-t', String(this.config.maxSeconds + 1), '-f', 's16le', 'pipe:1'], deadline, input, (this.config.maxSeconds + 1) * 32000);
      if (!pcm.length || pcm.length % 2 || pcm.length > this.config.maxSeconds * 32000) return unavailable('duration-limit');
      deadline.throwIfAborted();
      directory = await realpath(await mkdtemp(join(tmpdir(), 'riftjack-audio-')));
      const audio = join(directory, 'audio.wav'), output = join(directory, 'transcript.txt');
      await writeFile(audio, wav(pcm), { mode: 0o600, flag: 'wx' });
      await run(this.config.executable, ['-m', this.config.model, '--quiet', '--threads', '2', '--timestamps', 'none', '-o', output, audio], deadline);
      const text = (await readOutgoing({ path: output, root: directory }, MAX_TEXT_BYTES)).toString('utf8').trim();
      deadline.throwIfAborted();
      return { ...file, transcription: { status: 'complete', text, automatic: true } };
    } catch {
      signal.throwIfAborted(); // Cancellation stops the task; other failures keep the audio usable.
      return unavailable('processing-failed');
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { this.busy = false; }
    }
  }
}
