import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PublicError, safeErrorSummary } from './errors.js';
import type { ToolAction } from './tool-mcp.js';

// A read-only HTTP GET limited to URL prefixes configured by the human. The agent
// chooses only the URL; credentials stay in the connector and are attached only to
// URLs under the prefix they were configured for. The connector runs outside the
// agent's sandbox, so it also refuses non-public addresses and saves responses only
// through scripts/fetch-save.py, which never follows a symlink in the workspace.

export type FetchPrefix = { protocol: string; host: string; wildcard: boolean; path: string; text: string };
export type FetchAuth = { prefix: FetchPrefix; header: string };
export type FetchConfig = { allow: FetchPrefix[]; auth: FetchAuth[]; maxBytes: number; python: string };

const MIN_BYTES = 65_536;
const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 120_000; // all hops and the body together

// "https://api.github.com/repos/x/y/" or "https://*.blob.core.windows.net/". The
// path must end with "/" so that a prefix never matches a sibling such as "y-evil".
export function parsePrefix(text: string): FetchPrefix {
  const wildcard = /^https:\/\/\*\./.test(text);
  let url: URL;
  try { url = new URL(wildcard ? text.replace('*.', '') : text); } catch { throw new Error(`Invalid fetch prefix: ${text}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
    throw new Error(`Fetch prefixes must be HTTPS URLs ending with "/", without credentials, query or fragment: ${text}`);
  }
  return { protocol: url.protocol, host: url.host, wildcard, path: url.pathname, text };
}

const HELPER = fileURLToPath(new URL('../scripts/fetch-save.py', import.meta.url));
export const FETCH_DIR = '.fetch';

// Python 3 is not part of every macOS install; the helper needs openat-style calls.
function findPython(env: NodeJS.ProcessEnv, workspace?: string): string {
  const named = env.FETCH_PYTHON?.trim();
  const candidates = named ? [named] : (env.PATH ?? process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, 'python3'));
  for (const candidate of candidates) {
    let real: string;
    try { accessSync(candidate, constants.X_OK); real = realpathSync(candidate); } catch { continue; }
    if (workspace && (real + sep).startsWith(workspace + sep)) throw new Error('FETCH_PYTHON must be outside RIFTJACK_WORKSPACE, where agents can change it.');
    const check = spawnSync(real, ['-c', 'import os,sys; sys.exit(0 if {os.open, os.mkdir, os.unlink} <= os.supports_dir_fd else 1)'], { timeout: 10_000 });
    if (check.status === 0) return real;
  }
  throw new Error('The fetch tool needs Python 3 with dir_fd support to save responses. Install it or set FETCH_PYTHON to its absolute path.');
}

// `workspace` is the agents' writable directory; the Python used to save responses must be outside it.
export function loadFetchConfig(env: NodeJS.ProcessEnv, workspace?: string): FetchConfig | undefined {
  const allow = (env.FETCH_ALLOW || '').split(/[\s,]+/).filter(Boolean).map(parsePrefix);
  if (!allow.length) return undefined;
  // FETCH_AUTH: entries "prefix|file"; the file holds a bearer token for that prefix only.
  // This keeps the token out of the model, not out of a file the agent can read.
  const auth = (env.FETCH_AUTH || '').split(/\s+/).filter(Boolean).map(entry => {
    const [prefixText, file] = entry.split('|');
    if (!prefixText || !file) throw new Error('FETCH_AUTH entries must look like https://host/path/|/path/to/token');
    const prefix = parsePrefix(prefixText);
    if (prefix.wildcard || !allow.some(a => covers(a, prefix))) throw new Error(`FETCH_AUTH prefix must be inside FETCH_ALLOW and not a wildcard: ${prefixText}`);
    const token = readFileSync(file, 'utf8').trim();
    if (!token || /\s/.test(token)) throw new Error(`FETCH_AUTH token file is empty or malformed: ${file}`);
    return { prefix, header: `Bearer ${token}` };
  });
  const maxBytes = Number(env.FETCH_MAX_BYTES || '20971520');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_BYTES || maxBytes > 268_435_456) throw new Error('FETCH_MAX_BYTES must be between 65536 and 268435456.');
  return { allow, auth, maxBytes, python: findPython(env, workspace) };
}

function hostMatches(prefix: FetchPrefix, host: string): boolean {
  return prefix.wildcard ? host.endsWith('.' + prefix.host) : host === prefix.host;
}

function covers(outer: FetchPrefix, inner: FetchPrefix): boolean {
  return outer.protocol === inner.protocol && (outer.wildcard ? !inner.wildcard && hostMatches(outer, inner.host) : outer.host === inner.host && !inner.wildcard)
    && inner.path.startsWith(outer.path);
}

// Encoded dots and slashes could be decoded by the server after our prefix check.
export function matches(prefix: FetchPrefix, url: URL): boolean {
  return url.protocol === prefix.protocol && hostMatches(prefix, url.host) && url.pathname.startsWith(prefix.path)
    && !/%2e|%2f|%5c/i.test(url.pathname) && !url.username && !url.password;
}

export function allowedUrl(config: FetchConfig, text: unknown): URL {
  if (typeof text !== 'string' || text.length > 4096) throw new PublicError('Pass url as a string of at most 4096 characters.');
  let url: URL;
  try { url = new URL(text); } catch { throw new PublicError('The url is not a valid absolute URL.'); }
  url.hash = '';
  if (!config.allow.some(p => matches(p, url))) {
    throw new PublicError(`This URL is not allowed. Allowed prefixes: ${config.allow.map(p => p.text).join(', ')}`);
  }
  // An IP literal is never resolved, so check it here; names are checked at connect time.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && !isPublicAddress(literal)) throw new PublicError('This URL points to a non-public address.');
  return url;
}

// Loopback, private, link-local, shared, documentation, multicast and reserved ranges.
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  if (/^::ffff:/i.test(address)) return false; // hex form of a mapped address
  return !blocked.check(address, 'ipv6');
}

class NonPublicAddress extends Error { code = 'ERR_RIFTJACK_NON_PUBLIC'; }

// The check runs inside the lookup that the connection itself uses, so a second
// resolution cannot substitute another address.
type LookupCallback = (error: Error | null, address: string | LookupAddress[], family?: number) => void;
export function publicLookup(hostname: string, options: { all?: boolean; family?: number } | undefined, callback: LookupCallback) {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return callback(new NonPublicAddress('non-public address'), '');
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export type FetchResponse = { status: number; location?: string; contentType: string; body: AsyncIterable<Uint8Array> & { destroy(): void } };
export type Transport = (url: URL, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>;

export const httpsTransport: Transport = (url, init) => new Promise((resolve, reject) => {
  const req = request(url, { method: init.method, headers: init.headers, signal: init.signal, agent: false, lookup: publicLookup as never }, res => {
    const location = res.headers.location;
    resolve({ status: res.statusCode || 0, location: typeof location === 'string' ? location : undefined,
      contentType: res.headers['content-type'] || '', body: res });
  });
  req.once('error', reject);
  req.end();
});

type Helper = ChildProcessByStdio<Writable, Readable, Readable>;
const HELPER_EXIT_MS = 5_000;

// Every wait on the helper ends when the operation is cancelled or times out.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// Resolves when the helper prints `until` or exits; returns its output so far.
function helperOutput(child: Helper, exited: Promise<number | null>, until?: string): Promise<string> {
  let out = '';
  return new Promise<string>(resolve => {
    const onData = (data: Buffer) => { out += data; if (until && out.includes(until)) { child.stdout.off('data', onData); resolve(out); } };
    child.stdout.on('data', onData);
    exited.then(() => resolve(out));
  });
}

async function frame(stdin: Writable, data: Uint8Array, signal: AbortSignal) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  if (!stdin.write(Buffer.concat([header, data]))) await abortable(Promise.race([once(stdin, 'drain'), once(stdin, 'close')]), signal);
  if (stdin.destroyed) throw new Error('The save helper stopped accepting data.');
}

// Streams the body into <workspace>/.fetch/<name> through the helper. Without the final
// empty frame the helper removes the file, so any failure here leaves nothing behind.
async function saveBody(config: FetchConfig, workspace: string, name: string, body: FetchResponse['body'], deadline: AbortSignal) {
  const child = spawn(config.python, [HELPER, workspace, name, String(config.maxBytes)], { stdio: ['pipe', 'pipe', 'pipe'] }) as Helper;
  let stderr = '', exitCode: number | null | undefined;
  child.stderr.on('data', (data: Buffer) => { if (stderr.length < 1000) stderr += data; });
  child.stdin.on('error', () => {});
  const exited = new Promise<number | null>(resolve => {
    child.once('close', code => resolve(exitCode = code));
    child.once('error', () => resolve(exitCode = null));
  });
  const failure = () => new Error(stderr.trim().split('\n').pop() || 'the save helper failed');
  let bytes = 0, truncated = false, committed = false;
  try {
    if (!(await abortable(helperOutput(child, exited, 'ready\n'), deadline)).includes('ready\n')) throw failure();
    for await (const chunk of body) {
      deadline.throwIfAborted();
      const take = Math.min(chunk.length, config.maxBytes - bytes);
      if (take) await frame(child.stdin, chunk.subarray(0, take), deadline);
      bytes += take;
      if (take < chunk.length) { truncated = true; break; }
    }
    deadline.throwIfAborted();
    const saved = helperOutput(child, exited);
    await frame(child.stdin, new Uint8Array(0), deadline);
    committed = true;
    child.stdin.end();
    const [code, out] = await abortable(Promise.all([exited, saved]), deadline);
    if (code !== 0 || !out.includes(`saved ${bytes}\n`)) throw failure();
    return { bytes, truncated };
  } finally {
    if (exitCode === undefined) {
      // Before the commit, end of input or SIGTERM makes the helper remove the file and
      // exit; one that does not exit in time is killed, so cleanup is always bounded.
      child.stdin.end();
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), HELPER_EXIT_MS);
      await exited;
      clearTimeout(timer);
    }
  }
}

// Responses are saved in <workspace>/.fetch of the bot's own workspace. The agent can
// write there too, so the connector never opens the path itself: the helper opens each
// directory relative to the previous one without following symlinks.
export function fetchAction(config: FetchConfig, workspace: string, transport: Transport = httpsTransport): ToolAction {
  return async (input, signal) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PublicError('Pass an object with url and optional method.');
    const { url: urlText, method = 'GET', ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length) throw new PublicError(`Unknown arguments: ${Object.keys(rest).join(', ')}`);
    if (method !== 'GET' && method !== 'HEAD') throw new PublicError('Only GET and HEAD are allowed.');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(TOTAL_TIMEOUT_MS)]);
    let url = allowedUrl(config, urlText);
    let response: FetchResponse;
    for (let hop = 0; ; hop++) {
      // Credentials are chosen for each hop by its own URL, so they never follow a redirect out of their prefix.
      const auth = config.auth.find(a => matches(a.prefix, url));
      try {
        response = await transport(url, { method, signal: deadline,
          headers: { 'User-Agent': 'riftjack-fetch', ...(auth ? { Authorization: auth.header } : {}) } });
      } catch (cause) {
        if (signal.aborted) throw cause;
        if ((cause as { code?: string })?.code === 'ERR_RIFTJACK_NON_PUBLIC') throw new PublicError('Refused: the host resolves to a non-public address.');
        throw new PublicError(`Request failed: ${deadline.aborted ? 'timed out' : safeErrorSummary(cause)}.`);
      }
      // A stream error before we start reading must reach the reader, not crash the process.
      (response.body as Partial<Readable>).on?.('error', () => {});
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      response.body.destroy();
      if (!response.location || hop >= MAX_REDIRECTS) throw new PublicError(`Too many or invalid redirects (HTTP ${response.status}).`);
      try { url = allowedUrl(config, new URL(response.location, url).toString()); }
      catch (cause) { throw new PublicError(`Redirect to a URL that is not allowed: ${cause instanceof PublicError ? cause.message : 'invalid location'}`); }
    }
    const head = { status: response.status, url: url.toString(), contentType: response.contentType };
    if (method === 'HEAD') { response.body.destroy(); return JSON.stringify({ ...head, bytes: 0 }); }
    // The body always goes to a new file: the agent reads it with its own file tools,
    // and a large log never floods the conversation.
    const textual = /^(text\/|application\/(json|xml|javascript|[\w.+-]*\+json|[\w.+-]*\+xml))/i.test(response.contentType) || !response.contentType;
    const name = `${Date.now()}-${randomBytes(6).toString('hex')}${textual ? '.txt' : '.bin'}`;
    let saved: { bytes: number; truncated: boolean };
    try {
      saved = await saveBody(config, workspace, name, response.body, deadline);
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new PublicError(`Saving the response failed: ${deadline.aborted ? 'timed out' : safeErrorSummary(cause)}.`);
    } finally {
      // Runs for every failure, including a refused open, so the connection never lingers.
      response.body.destroy();
    }
    return JSON.stringify({ ...head, ...saved, file: join(workspace, FETCH_DIR, name) });
  };
}
