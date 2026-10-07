// Executed by Claude's synchronous SessionStart(compact) hook. Never reads or
// writes personal notes; only constructs a pointer for the agent's own tools.
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';

const [workspace, template] = process.argv.slice(2);
try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error('Hook input too large');
  }
  const event = JSON.parse(input);
  if (event.hook_event_name === 'SessionStart' && event.source === 'compact'
    && typeof event.session_id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(event.session_id)
    && workspace && isAbsolute(workspace) && template?.includes('CHECKPOINT_PATH')) {
    const name = createHash('sha256').update('claude\0' + event.session_id).digest('hex') + '.md';
    const path = join(workspace, '.riftjack', 'checkpoints', name);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart',
      additionalContext: template.replace('CHECKPOINT_PATH', () => JSON.stringify(path)) } }));
  }
} catch {
  // Do not echo potentially sensitive CLI input in diagnostics.
  process.stderr.write('Riftjack continuity hook failed.\n');
  process.exitCode = 1;
}
