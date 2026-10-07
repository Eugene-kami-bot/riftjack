import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botStatus, engineReport } from '../src/bot-status.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@owner:test', RIFTJACK_WORKSPACE: process.cwd(),
  CODEX_MODEL: 'requested-model', CODEX_REASONING_EFFORT: 'high', CODEX_SERVICE_TIER: 'priority', CLAUDE_MODEL: 'requested-claude' });

test('status separates configured and reported settings and labels missing metadata', () => {
  const report = engineReport({ model: 'resolved-model', reasoningEffort: 'medium', serviceTier: 'default', cwd: '/projects/previous' });
  const text = botStatus('codex', config, { codexReport: report });
  const [settings, reported] = text.split('**Last CLI session report**');
  assert.match(settings, /requested\\-model/);
  assert.match(settings, /high/);
  assert.match(settings, /priority/);
  assert.match(reported, /resolved\\-model/);
  assert.match(reported, /medium/);
  assert.match(reported, /default/);
  assert.match(reported, /previous/);
  assert.match(reported, /not a live query/);
  assert.doesNotMatch(reported, /requested/);
  const claude = botStatus('claude', config, { claudeReport: engineReport({ model: 'claude-model' }) });
  assert.match(claude, /Reasoning: unknown/);
  assert.match(claude, /Fast mode: unknown/);
  assert.match(claude, /Service tier: automatic/);
  assert.match(botStatus('codex', config, {}), /No report yet/);
  assert.match(botStatus('claude', { ...config, claudeModel: undefined }, {}), /automatic/);
  assert.doesNotMatch(botStatus('claude', config, { codexReport: report }), /resolved/);
});

test('CLI reports whitelist metadata, reject malformed fields and escape Markdown', () => {
  const report = engineReport({ model: '[model](https://example.com)', cwd: '/projects/**demo**', reasoningEffort: null,
    serviceTier: { secret: 'private' }, fastMode: 'on\nsecret', permissionMode: 'x'.repeat(1025), accessToken: 'secret', thread: { turns: ['private'] } });
  assert.deepEqual(Object.keys(report).sort(), ['cwd', 'model', 'reportedAt']);
  const text = botStatus('codex', config, { codexReport: report });
  assert.ok(text.includes('\\[model\\]\\(https://example\\.com\\)'));
  assert.ok(text.includes('/projects/\\*\\*demo\\*\\*'));
  assert.doesNotMatch(text, /secret|private/);
});
