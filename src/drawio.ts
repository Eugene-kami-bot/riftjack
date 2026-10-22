import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { PublicError } from './errors.js';
import { outgoingAttachments, readOutgoing } from './media.js';
import { diagramSource } from './drawio-source.js';
import { embedDiagram, extractDiagram, MAX_PNG } from './drawio-png.js';
import type { ToolAction } from './tool-mcp.js';

export type DrawioConfig = { executable: string };
export function drawioOutsideWorkspace(config: DrawioConfig, workspace: string) {
  if (config.executable.startsWith(workspace + sep)) throw new Error('DRAWIO_PATH must be outside every agent workspace.');
}
export function loadDrawioConfig(env: NodeJS.ProcessEnv, workspace: string): DrawioConfig | undefined {
  const value = env.DRAWIO_PATH?.trim();
  if (!value) return undefined;
  if (process.platform === 'win32') throw new Error('The draw.io tool currently supports macOS and Linux.');
  if (!isAbsolute(value)) throw new Error('DRAWIO_PATH must be an absolute executable path.');
  const executable = realpathSync(value);
  if (!statSync(executable).isFile()) throw new Error('DRAWIO_PATH must be a regular executable file.');
  accessSync(executable, constants.X_OK);
  const config = { executable };
  drawioOutsideWorkspace(config, workspace);
  return config;
}

export type Renderer = (executable: string, directory: string, signal: AbortSignal) => Promise<void>;
// A dedicated profile keeps this export separate from an interactive editor. No
// shell, connector credentials, plugins or user profile are inherited.
export const renderDrawio: Renderer = async (executable, directory, signal) => {
  signal.throwIfAborted();
  const home = join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {};
  // macOS Electron needs the real HOME to finish startup. The separate
  // --user-data-dir below isolates draw.io settings without replacing HOME.
  for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) env[key] = process.env[key];
  const common = [`--user-data-dir=${join(home, 'profile')}`, '--disable-gpu', '--disable-background-networking',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
    '--export', '--border', '10'];
  const run = async (format: 'svg' | 'png', dimensions: string[] = []) => {
    signal.throwIfAborted();
    const target = join(directory, 'render.' + format);
    const args = [...common, '--format', format, ...dimensions, '--output', target, join(directory, 'input.drawio')];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: directory, env, detached: true, stdio: 'ignore' });
      let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, sig); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new Error('Could not stop draw.io.'); }
      };
      const stop = (error: Error) => {
        if (failure) return;
        failure = error; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      };
      const abort = () => stop(new PublicError('Diagram rendering cancelled or timed out.'));
      signal.addEventListener('abort', abort, { once: true });
      const sizeTimer = setInterval(() => { void stat(target).then(s => {
        if (s.size > MAX_PNG) stop(new PublicError('Rendered PNG exceeds 32 MiB.'));
      }).catch(() => {}); }, 100);
      child.once('error', e => { failure = e; });
      child.once('close', code => {
        clearInterval(sizeTimer); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        // Also reap helpers left by a failed/aborted Electron parent before cleanup.
        kill('SIGKILL');
        if (failure) reject(failure);
        else if (code !== 0) reject(new PublicError('draw.io export failed. Check the configured desktop executable and display on the host.'));
        else resolve();
      });
      if (signal.aborted) abort();
    });
  };
  // Desktop treats height as an override, not a second bounding dimension.
  // Measure a vector export first, then constrain only the longer side.
  await run('svg');
  const svg = await readOutgoing({ root: directory, path: join(directory, 'render.svg') }, MAX_PNG);
  const header = /<svg\b[^>]*>/.exec(svg.toString('utf8'))?.[0] ?? '';
  const width = Number(/\bwidth="([0-9.]+)(?:px)?"/.exec(header)?.[1]);
  const height = Number(/\bheight="([0-9.]+)(?:px)?"/.exec(header)?.[1]);
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new PublicError('Could not determine diagram dimensions.');
  await run('png', [width >= height ? '--width' : '--height', '2048']);
};

// Shared across all conversations/backends in this connector process. Refuse
// overlap instead of holding an unbounded queue of multi-megabyte XML requests.
let rendering = false;
export function drawioAction(config: DrawioConfig, outbox: string, maxMediaBytes: number, renderer: Renderer = renderDrawio): ToolAction {
  return async (input, signal) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Expected a diagram request.');
    const p = input as Record<string, unknown>;
    const allowed = p.action === 'render' ? ['action', 'xml', 'page'] : p.action === 'extract' ? ['action', 'path'] : [];
    if (!allowed.length || Object.keys(p).some(k => !allowed.includes(k))) throw new PublicError('Use render with xml and optional page, or extract with an outbox path.');
    signal.throwIfAborted();
    if (await realpath(outbox) !== outbox) throw new PublicError('Outbox must not be a symlink.');
    const save = async (data: Buffer | string, extension: string, metadata: object) => {
      signal.throwIfAborted();
      if (Buffer.byteLength(data) > maxMediaBytes) throw new PublicError('Result exceeds the configured attachment size limit.');
      const path = 'diagram-' + randomUUID() + extension;
      if (await realpath(outbox) !== outbox) throw new PublicError('Outbox must not be a symlink.');
      await writeFile(join(outbox, path), data, { flag: 'wx', mode: 0o600 });
      return JSON.stringify({ path, file: join(outbox, path), bytes: Buffer.byteLength(data), ...metadata });
    };
    if (p.action === 'extract') {
      if (typeof p.path !== 'string') throw new PublicError('Copy the PNG into this conversation outbox and pass its relative path.');
      const [file] = outgoingAttachments({ files: [{ path: p.path }] }, outbox);
      const xml = extractDiagram(await readOutgoing(file, MAX_PNG));
      return save(xml, '.drawio', { untrusted: true });
    }
    if (typeof p.xml !== 'string' || (p.page !== undefined && typeof p.page !== 'number')) throw new PublicError('Supply XML text and an optional integer page.');
    if (rendering) throw new PublicError('Another diagram is rendering. Retry after it completes.');
    const model = diagramSource(p.xml, p.page as number | undefined);
    rendering = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(outbox, '.drawio-'));
      await writeFile(join(directory, 'input.drawio'), model.renderXml, { mode: 0o600, flag: 'wx' });
      const lifetime = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      await renderer(config.executable, directory, lifetime);
      lifetime.throwIfAborted();
      const rendered = await readOutgoing({ root: directory, path: join(directory, 'render.png') }, MAX_PNG);
      const png = embedDiagram(rendered, p.xml);
      if (png.readUInt32BE(16) > 2048 || png.readUInt32BE(20) > 2048) throw new PublicError('Rendered diagram exceeds 2048 pixels per side.');
      if (extractDiagram(png) !== p.xml) throw new PublicError('Embedded diagram source did not round-trip.');
      return await save(png, '.png', { page: model.page, pages: model.pages, editable: true });
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { rendering = false; }
    }
  };
}
