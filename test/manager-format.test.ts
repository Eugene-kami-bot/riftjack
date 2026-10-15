import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managerBotList, markdownText, inlineCode } from '../src/manager-format.js';
import { MANAGER_HELP } from '../src/manager-help.js';
import { replyContent } from '../src/message-format.js';
import { botHelp } from '../src/bot-help.js';

test('manager list renders separate named entries with literal IDs and folders', () => {
  const name = '**Bot** [link](https://example.com) <b>name</b>';
  const path = '/workspace/a_*_`code` & <folder>';
  const source = managerBotList([
    { name: 'Bot Manager', kind: 'manager', userId: '@manager:test', accessToken: 'never-output-this' },
    { name, kind: 'codex', userId: '@bot_codex_x_123456abcdef:test', workspace: path, accessToken: 'never-output-this' },
  ], '/default');
  const parts = replyContent(source, true);
  const html = parts.map(p => p.formatted_body).join('');
  const plain = parts.map(p => p.body).join('');
  assert.match(html, /<h3>Bots<\/h3>/);
  assert.match(html, /<strong>Bot Manager<\/strong>/);
  assert.match(html, /<code>@bot_codex_x_123456abcdef:test<\/code>/);
  assert.ok(plain.includes(name)); assert.ok(plain.includes(path));
  assert.doesNotMatch(html, /<a |<b>|never-output-this|\/default/);
});

test('manager help formats headings and copyable commands without changing syntax', () => {
  const parts = replyContent(MANAGER_HELP, true);
  const html = parts.map(p => p.formatted_body).join('');
  const plain = parts.map(p => p.body).join('');
  assert.match(html, /<h3>Create a bot<\/h3>/);
  assert.match(html, /<code>create a Codex bot called Builder<\/code>/);
  assert.ok(plain.includes('set avatar Riftjack Codex'));
  assert.ok(plain.includes('!approve or ✅ — proceed'));
});

for (const kind of ['codex', 'claude'] as const) test(kind + ' help renders lists, examples and commands with readable fallback', () => {
  const parts = replyContent(botHelp(kind), true);
  const html = parts.map(p => p.formatted_body).join('');
  const plain = parts.map(p => p.body).join('');
  assert.ok(parts.every(p => p.format === 'org.matrix.custom.html'));
  assert.match(html, /<h2>/);
  assert.match(html, /<h3>Basic commands<\/h3>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<blockquote>/);
  for (const command of ['!help', '!reset', '!cancel', '!approve', '!deny', '!usage', '!restart supervisor', '!tasks']) {
    assert.ok(html.includes(`<code>${command}</code>`));
    assert.ok(plain.includes(command));
  }
  assert.equal(plain.includes('!plugin install github'), kind === 'codex');
  assert.equal(plain.includes('steering'), kind === 'codex');
  assert.doesNotMatch(plain, /<\/?(?:h2|ul|code)>|```|###|\*\*/);
});

test('literal Markdown and variable-length backtick fences survive formatting', () => {
  for (const text of ['a`b``c', '**bold** &amp; _x_', '![pic](https://example.com/x)', '<script>bad</script>']) {
    for (const source of [markdownText(text), inlineCode(text)]) {
      const parts = replyContent(source, true);
      assert.equal(parts.map(p => p.body).join('').trim(), text);
      assert.doesNotMatch(parts.map(p => p.formatted_body).join(''), /<script>|<img|<a /);
    }
  }
});
