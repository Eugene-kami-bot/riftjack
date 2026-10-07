import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServer } from '../src/app-server.js';
import { loadConfig } from '../src/config.js';
import { errorMessage } from '../src/errors.js';

function fixture(t: { after(fn: () => unknown): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'rpc-diagnostics-'));
  const executable = join(directory, 'codex.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.params?.reject) return process.stdout.write(JSON.stringify({ id: request.id, error: { code: request.params.code, message: request.params.message ?? 'private server diagnostic with a secret', data: { token: 'private-data-secret' } } }) + '\\n');
  if (request.method === 'exit') process.exit(17);
  if (request.method === 'malformed') return process.stdout.write('private diagnostic, not JSON\\n');
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o700 });
  const failures: Error[] = [];
  const server = new AppServer(loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test',
    RIFTJACK_WORKSPACE: directory, CODEX_PATH: executable }), () => {}, error => failures.push(error));
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { server, failures };
}

test('RPC timeouts identify the operation without revealing parameters or unknown method names', async t => {
  const { server } = fixture(t);
  await server.initialize();
  for (const method of ['thread/resume', 'private-method-secret']) {
    await assert.rejects(server.request(method, { token: 'private-parameter-secret' }, 10), error => {
      const message = errorMessage(error);
      assert.match(message, /timed out waiting for/);
      assert.match(message, method === 'thread/resume' ? /thread\/resume/ : /for request/);
      assert.doesNotMatch(message, /private|Task failed: Error/);
      return true;
    });
  }
  // Expired requests must not poison the transport or be retried automatically.
  await server.initialize();
});

test('unexpected CLI exit preserves its safe exit code in chat diagnostics', async t => {
  const { server, failures } = fixture(t);
  await server.initialize();
  await assert.rejects(server.request('exit', {}), error => {
    assert.match(errorMessage(error), /Codex App Server exited \(code 17\)/);
    return true;
  });
  assert.equal(failures.length, 1);
});

test('malformed CLI output reports the protocol failure without exposing its contents', async t => {
  const { server } = fixture(t);
  await server.initialize();
  await assert.rejects(server.request('malformed', {}), error => {
    assert.match(errorMessage(error), /Could not process a Codex App Server response/);
    assert.doesNotMatch(errorMessage(error), /private diagnostic/);
    return true;
  });
});

test('RPC rejections identify the operation and code without exposing server diagnostics', async t => {
  const { server } = fixture(t);
  await server.initialize();
  for (const [method, operation] of [['thread/resume', 'thread/resume'], ['thread/start', 'thread/start'],
    ['turn/start', 'turn/start'], ['private-method-secret', 'request']]) {
    await assert.rejects(server.request(method, { reject: true, code: -32602, token: 'private-parameter-secret' }), error => {
      assert.equal(errorMessage(error), `Codex App Server rejected ${operation} (RPC -32602).`);
      return true;
    });
  }
  // Do not interpolate malformed codes, even when a server puts private text there.
  await assert.rejects(server.request('turn/start', { reject: true, code: 'private-code-secret' }), error => {
    assert.equal(errorMessage(error), 'Codex App Server rejected turn/start.');
    return true;
  });
  await server.initialize();
});

test('account failures preserve known reasons while discarding sensitive suffixes and error data', async t => {
  const { server } = fixture(t);
  await server.initialize();
  const secret = 'private@example.test Bearer private-token /private/auth.json';
  const prefix = 'Your access token could not be refreshed';
  for (const [message, reason] of [
    ['failed to load auth: ' + secret, 'auth-load-failed'],
    [prefix + ' because your refresh token has expired. ' + secret, 'refresh-token-expired'],
    ['failed to load auth: ' + prefix + ' because your refresh token was already used. ' + secret, 'refresh-token-reused'],
    [prefix + ' because your refresh token was revoked. ' + secret, 'refresh-token-revoked'],
    [prefix + ' because you have since logged out or signed in to another account. ' + secret, 'auth-account-changed'],
    [prefix + '. ' + secret, 'auth-refresh-failed'],
    [secret + ' failed to load auth: ', 'unclassified'],
    [{ token: secret }, 'unclassified'],
    ['failed to load auth: ' + 'x'.repeat(16384), 'unclassified'],
  ] as const) {
    await assert.rejects(server.request('account/read', { reject: true, code: -32603, message }), error => {
      assert.equal(errorMessage(error), `Codex App Server rejected account/read (RPC -32603). Diagnostic: ${reason}.`);
      assert.doesNotMatch(String(error), /private|Bearer|@example/);
      return true;
    });
  }
  // A matching phrase in another operation is not evidence of an account failure.
  await assert.rejects(server.request('turn/start', { reject: true, code: -32603, message: 'failed to load auth: ' + secret }),
    { message: 'Codex App Server rejected turn/start (RPC -32603).' });
  await server.initialize();
});
