import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAuthenticationFailure, codexAccountFailure } from '../src/auth-diagnostics.js';

test('malformed and embedded diagnostics cannot supply public text', () => {
  for (const value of [null, undefined, 401, {}, { text: 'Not logged in · Please run /login' },
    [{ type: 'tool_use', text: 'Not logged in · Please run /login' }],
    [{ type: 'text', text: 'secret API Error: 401 token' }],
    [{ type: 'text', text: 'API Error: 401 ' + 'x'.repeat(16384) }]]) {
    assert.equal(claudeAuthenticationFailure(value), 'unclassified');
  }
  assert.equal(claudeAuthenticationFailure([{ type: 'text', text: 'API Error: 403 secret' }]), 'http-forbidden');
  assert.equal(codexAccountFailure('failed to load auth: secret refresh token has expired'), 'auth-load-failed');
});
