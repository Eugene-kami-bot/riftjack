import type { PublishReview } from './publish.js';
import { wordDiff, type WordChange } from './word-diff.js';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Report = Omit<PublishReview, 'html' | 'sha256'>;

type DiffRow = { line: string; left: string; right: string; kind: string; html?: string };

function wordMarkup(changes: WordChange[]): string[] {
  return changes.map(part => part.text.split('\n').map(text => part.changed && text
    ? `<span class="word-change">${escape(text)}</span>` : escape(text)).join('\n')).join('').split('\n');
}

function highlightReplacements(rows: DiffRow[]): void {
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== 'add' && rows[i].kind !== 'del') { i++; continue; }
    const removed: DiffRow[] = [], added: DiffRow[] = [];
    while (i < rows.length) {
      const row = rows[i];
      if (row.kind === 'del') removed.push(row);
      else if (row.kind === 'add') added.push(row);
      else if (!row.line.startsWith('\\ No newline at end of file')) break;
      i++;
    }
    if (!removed.length || !added.length) continue;
    const changes = wordDiff(removed.map(r => r.line.slice(1)).join('\n'), added.map(r => r.line.slice(1)).join('\n'));
    for (const [side, parts] of [[removed, changes[0]], [added, changes[1]]] as const) {
      const html = wordMarkup(parts);
      side.forEach((row, index) => { row.html = row.line[0] + html[index]; });
    }
  }
}

function diff(text: string, prefix: string): string {
  let old = 0, next = 0, inHunk = false;
  const pieces = text.split(/(?=^diff --git )/m);
  return pieces.filter(Boolean).map((piece, i) => {
    const lines = piece.replace(/\n$/, '').split('\n');
    const title = lines[0].startsWith('diff --git ') ? lines.shift()!.slice(11) : 'Commit metadata';
    inHunk = false;
    const rows: DiffRow[] = lines.map(line => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      let left = '', right = '', kind = 'meta';
      if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; kind = 'hunk'; }
      else if (inHunk && line.startsWith('+')) { right = String(next++); kind = 'add'; }
      else if (inHunk && line.startsWith('-')) { left = String(old++); kind = 'del'; }
      else if (inHunk && line.startsWith(' ')) { left = String(old++); right = String(next++); kind = 'context'; }
      return { line, left, right, kind };
    });
    highlightReplacements(rows);
    const body = rows.map(row => `<div class="line ${row.kind}"><span class="number">${row.left}</span><span class="number">${row.right}</span><code>${row.html ?? escape(row.line)}</code></div>`).join('');
    const binary = lines.some(l => l.startsWith('Binary files ')) ? ' · binary content not shown' : '';
    return `<details open id="${prefix}-${i}"><summary>${escape(title + binary)}</summary><div class="diff">${body}</div></details>`;
  }).join('');
}

export function renderPublishReview(review: Report): string {
  const e = escape;
  const fileHeaders = review.patch.split('\n').filter(line => line.startsWith('diff --git '));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Publish review ${e(review.head.slice(0, 12))}</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:#10151d;color:#dce4ef;font:16px/1.55 system-ui,sans-serif}main{width:100%;padding:28px 16px 64px}h1{font-size:30px;margin:0 0 8px}h2{margin-top:32px}a{color:#89c4ff}dl{display:grid;grid-template-columns:130px 1fr;gap:8px;background:#19212d;padding:18px;border-radius:10px}dt{color:#9dabbe}dd{margin:0;overflow-wrap:anywhere}code{font:13px/1.6 ui-monospace,monospace}.notice{padding:14px;border-left:4px solid #d8ac65;background:#26251f}details{margin:12px 0;border:1px solid #344155;border-radius:8px;overflow:hidden}summary{cursor:pointer;padding:12px;background:#1b2635;overflow-wrap:anywhere}.diff{overflow-x:auto;padding:6px 0;background:#111923}.line{display:flex;min-width:0}.line code{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;tab-size:4;padding:0 12px;flex:1}.number{width:48px;flex-shrink:0;text-align:right;padding-right:8px;color:#93a4b9;user-select:none;font:12px/1.75 ui-monospace,monospace;border-right:1px solid #344155}.add{background:#14372a;color:#b9efcb}.del{background:#41232b;color:#ffd0d3}.add .word-change{background:#b5f5c8;color:#102d1b}.del .word-change{background:#ffbdc7;color:#40121d}.word-change{border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}.hunk{background:#18324c;color:#b4d9ff}.meta{color:#a8b8cc}nav ul{padding-left:20px}footer{color:#a8b8cc;margin-top:32px}@media(max-width:600px){dl{display:block}dt{margin-top:10px}.number{width:34px}h1{font-size:25px}}
</style></head><body><main>
<h1>Publication review</h1>${review.historyReplacement ? `<p class="notice"><strong>History replacement</strong>: ${review.removedHistory.length} commits will no longer be reachable from this destination branch. Review the removed history below as well as the outgoing history. The push uses an exact remote-tip lease and refuses concurrent updates.</p>` : ''}<p>${review.commits.length} outgoing commits · ${fileHeaders.length} files in the final diff</p>
<dl><dt>Repository</dt><dd><code>${e(review.repository)}</code></dd><dt>Destination</dt><dd><code>${e(review.url)} → refs/heads/${e(review.branch)}</code></dd><dt>Remote destination tip</dt><dd><code>${e(review.base ?? 'New branch')}</code></dd><dt>Review base</dt><dd><code>${e(review.reviewBase ?? 'Empty tree — complete history')}</code></dd>${review.baseReference ? `<dt>Published base</dt><dd><code>${e(review.baseReference.ref)} @ ${e(review.baseReference.head)}</code></dd>` : ''}<dt>Publish HEAD</dt><dd><code>${e(review.head)}</code></dd><dt>Prepared</dt><dd>${e(review.createdAt)}</dd></dl>
<p class="notice">${review.workingTreeDirty ? 'Uncommitted or untracked files exist and are excluded. ' : ''}This review covers committed changes only. Both the final diff and every outgoing commit are included. Binary contents are marked but cannot be reviewed as text. This file does not publish anything or grant permission; confirm in Matrix after reviewing it.</p>
<nav><a href="#final">Final diff</a> · <a href="#history">Outgoing history</a>${review.historyReplacement ? ' · <a href="#removed">Removed history</a>' : ''}<ul>${fileHeaders.map((line, i) => `<li><a href="#final-${i}">${e(line.slice(11))}</a></li>`).join('')}</ul></nav>
<h2 id="final">Final diff</h2>${review.patch ? diff(review.patch, 'final') : '<p>No net file changes. Review the outgoing history below.</p>'}
<h2 id="history">Outgoing history</h2><p>Each commit is shown against its first parent (root commits against an empty tree). This includes changes later reverted and outgoing side-branch commits.</p>
${review.history.map((commit, i) => `<section><h3>${i + 1}. <code>${e(commit.oid)}</code></h3>${diff(commit.patch, 'commit-' + i)}</section>`).join('')}
${review.historyReplacement ? `<h2 id="removed">Removed history</h2><p>These commits are reachable from the old destination tip but not from the proposed HEAD. Their changes may be preserved by rewritten commits. Each patch below describes the old commit, not a patch being applied.</p>${review.removedHistory.map((commit, i) => `<section><h3>${i + 1}. <code>${e(commit.oid)}</code></h3>${diff(commit.patch, 'removed-' + i)}</section>`).join('')}` : ''}
<footer>Generated by Riftjack. Self-contained HTML; no scripts, external fonts, images or network resources. A successful upload does not certify that the file has been opened.</footer>
</main></body></html>`;
}
