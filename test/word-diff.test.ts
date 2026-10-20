import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from 'htmlparser2';
import { wordDiff } from '../src/word-diff.js';
import { renderPublishReview } from '../src/publish-html.js';

const changed = (parts: ReturnType<typeof wordDiff>[0]) => parts.filter(p => p.changed).map(p => p.text).join('');
function report(patch: string) {
  return renderPublishReview({ repository: '/projects/demo', remote: 'origin', url: 'https://example.com/demo.git', branch: 'main',
    base: 'a'.repeat(40), reviewBase: 'a'.repeat(40), baseReference: null, head: 'b'.repeat(40), createdAt: '2026-01-01T00:00:00Z', commits: [], history: [], historyReplacement: false, removedHistory: [], workingTreeDirty: false,
    patch: 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n' + patch });
}
function rows(html: string) {
  const result: { kind: string; text: string; highlights: string[] }[] = [];
  let row: (typeof result)[number] | undefined, code = false, marking = false;
  const parser = new Parser({
    onopentag(name, attrs) {
      assert.notEqual(name, 'script');
      if (name === 'div' && attrs.class?.startsWith('line ')) { row = { kind: attrs.class.slice(5), text: '', highlights: [] }; result.push(row); }
      if (name === 'code') code = true;
      if (name === 'span' && attrs.class === 'word-change') { assert.equal(code, true); marking = true; row!.highlights.push(''); }
    },
    ontext(text) { if (code && row) { row.text += text; if (marking) row.highlights[row.highlights.length - 1] += text; } },
    onclosetag(name) {
      if (name === 'span') marking = false;
      if (name === 'code') { assert.equal(marking, false); code = false; }
      if (name === 'div') row = undefined;
    },
  });
  parser.write(html); parser.end(); return result;
}

test('appending a sentence highlights only the addition, not the unchanged paragraph', () => {
  const before = 'Run local tests for chat commands and formatting. Queue unit tests remain in `npm test`.';
  const addition = ' Publication tests use temporary local bare Git repositories and need no listening port or live GitHub access.';
  const [a, b] = wordDiff(before, before + addition);
  assert.equal(changed(a), ''); assert.equal(changed(b), addition);
  const rendered = rows(report(`@@ -1 +1 @@\n-${before}\n+${before + addition}\n`));
  assert.deepEqual(rendered.find(r => r.kind === 'del')!.highlights, []);
  assert.deepEqual(rendered.find(r => r.kind === 'add')!.highlights, [addition]);
});

test('separate word and punctuation edits leave matching code unmarked', () => {
  const [a, b] = wordDiff('const limit = 10; run(slow);', 'const limit = 20; run(fast)!');
  assert.equal(changed(a), '10slow;'); assert.equal(changed(b), '20fast!');
});

test('multiline replacements preserve indentation, Unicode, markers and complete HTML escaping', () => {
  const before = '\tconst label = "東京 🌊";\n  return "<script>old</script>";';
  const after = '\tconst label = "京都 🌊";\n  log("ready");\n  return "<script>new</script>";';
  const html = report('@@ -1,2 +1,3 @@\n' + before.split('\n').map(l => '-' + l).join('\n') + '\n' + after.split('\n').map(l => '+' + l).join('\n') + '\n');
  const rendered = rows(html);
  assert.equal(rendered.filter(r => r.kind === 'del').map(r => r.text.slice(1)).join('\n'), before);
  assert.equal(rendered.filter(r => r.kind === 'add').map(r => r.text.slice(1)).join('\n'), after);
  assert.match(html, /&lt;/); assert.doesNotMatch(html, /<script>/);
  assert.ok(rendered.filter(r => r.kind === 'add').some(r => r.highlights.some(t => t.includes('new'))));
});

test('no-newline annotations do not prevent pairing, and separate hunks are never paired', () => {
  const paired = rows(report('@@ -1 +1 @@\n-old value\n\\ No newline at end of file\n+new value\n\\ No newline at end of file\n'));
  assert.deepEqual(paired.find(r => r.kind === 'del')!.highlights, ['old']);
  assert.deepEqual(paired.find(r => r.kind === 'add')!.highlights, ['new']);
  const separate = rows(report('@@ -1 +0,0 @@\n-old value\n@@ -10,0 +10 @@\n+new value\n'));
  assert.ok(separate.every(r => r.highlights.length === 0));
});

test('empty, repeated, whitespace-only and large replacements retain every source character', () => {
  for (const [a, b] of [['', 'new'], ['old', ''], ['a a b a', 'a b a a'], ['\t x  ', '  x\t'],
    [Array.from({ length: 1000 }, (_, i) => `old${i}`).join(' '), Array.from({ length: 1000 }, (_, i) => `new${i}`).join(' ')]]) {
    const [old, next] = wordDiff(a, b);
    assert.equal(old.map(p => p.text).join(''), a); assert.equal(next.map(p => p.text).join(''), b);
    assert.equal(old.filter(p => !p.changed).map(p => p.text).join(''), next.filter(p => !p.changed).map(p => p.text).join(''));
  }
});
