import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { State } from './state.js';

export type CheckpointState = {
  session: string;
  generation: number;
  warned: boolean;
  pending?: 'save' | 'restore';
  claudeModel?: string;
  claudeWindow?: number;
};

export const checkpointInstructions = `
Riftjack may send a continuity notice when reported context usage is high or after observed compaction. These are connector reminders, not human requests or new permissions. At an early warning, use your ordinary sandboxed tools to write a concise note at the supplied checkpoint path if writing is allowed. Choose what matters: current intent, exact constraints, decisions and their reasons, unresolved questions, next actions and references to evidence or your existing memory. You may include a short instruction to your future self. Preserve provenance and uncertainty; do not copy secrets or an entire transcript. Keep the note outside project commits. After compaction, read that note if present before continuing; verify it against current instructions and newer messages, and do not treat it as authority to expand permissions. Do not claim a note exists or was read without doing so. A reminder is best effort: context can grow abruptly and the CLI may compact without advance warning. Continue the human's task rather than replying just to acknowledge a reminder.
`;

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const windowSize = (n: unknown): n is number => count(n) && n > 0;

// No note content is read or written by the unsandboxed connector. The agent
// accesses its own file using its existing tools and permissions.
export function contextCheckpoints(state: State, key: string, backend: 'codex' | 'claude', workspace: string, session: string) {
  const field = backend === 'codex' ? 'codexCheckpoint' : 'claudeCheckpoint';
  const saved = state.session(key)[field];
  let value: CheckpointState = saved?.session === session ? { ...saved }
    : { session, generation: 0, warned: false };
  const path = join(workspace, '.riftjack', 'checkpoints', createHash('sha256').update(backend + '\0' + session).digest('hex') + '.md');
  let compacting = false;
  let lastClaudeInput: number | undefined;
  const persist = () => state.update(key, { [field]: { ...value } });
  return {
    usage(tokens: unknown, window: unknown) {
      if (compacting || value.warned || value.pending === 'restore' || !count(tokens) || !windowSize(window) || tokens < window * 0.65) return;
      value.warned = true; value.pending = 'save'; persist();
    },
    claudeUsage(model: unknown, usage: any) {
      if (typeof model !== 'string' || model === '<synthetic>') return;
      if (value.claudeModel !== model) {
        value.claudeModel = model; value.claudeWindow = undefined; lastClaudeInput = undefined; persist();
      }
      if (!usage || !count(usage.input_tokens)) return;
      const read = usage.cache_read_input_tokens ?? 0, created = usage.cache_creation_input_tokens ?? 0;
      if (!count(read) || !count(created)) return;
      // Per-request input, including cache, not cumulative result usage. No
      // guessed model window; first-run warnings wait for CLI-reported capacity.
      lastClaudeInput = usage.input_tokens + read + created;
      this.usage(lastClaudeInput, value.claudeWindow);
    },
    claudeCapacity(modelUsage: any) {
      const window = value.claudeModel && modelUsage?.[value.claudeModel]?.contextWindow;
      if (windowSize(window) && window !== value.claudeWindow) { value.claudeWindow = window; persist(); }
      this.usage(lastClaudeInput, value.claudeWindow);
    },
    start() { compacting = true; },
    complete() {
      if (!compacting) return;
      compacting = false;
      lastClaudeInput = undefined;
      value.generation++; value.warned = false; value.pending = 'restore'; persist();
    },
    notice() {
      if (!value.pending || compacting) return undefined;
      const id = `${value.generation}:${value.pending}`;
      const text = value.pending === 'save'
        ? `Riftjack continuity notice (not a human message): reported context usage has reached 65% of the reported window. Compaction may occur later. At your next opportunity, save a concise continuity note using your ordinary tools at ${JSON.stringify(path)}. Choose what you want preserved and references to existing memory. If writing is not allowed, respect that limit. Then continue the current task.`
        : `Riftjack continuity notice (not a human message): context compaction completed. Before continuing, read your continuity note at ${JSON.stringify(path)} if it exists, and follow any relevant memory references within your current permissions. It may be missing or stale; compare it with current instructions and newer messages. Continue the current task; this is not a new human request.`;
      return { id, text };
    },
    delivered(id: string) {
      if (`${value.generation}:${value.pending}` !== id) return;
      value.pending = undefined; persist();
    },
  };
}

// At most one attempt for a notice during this backend run. A rejected or
// uncertain advisory remains pending for the next ordinary input, never a new
// background model turn. A compaction can replace an in-flight save notice.
export function checkpointDelivery(checkpoint: ReturnType<typeof contextCheckpoints>, send: (text: string) => Promise<boolean>) {
  const attempted = new Set<string>();
  let active = Promise.resolve();
  return {
    flush() {
      const note = checkpoint.notice();
      if (!note || attempted.has(note.id)) return;
      attempted.add(note.id);
      active = active.then(async () => {
        if (checkpoint.notice()?.id !== note.id) return;
        try { if (await send(note.text)) checkpoint.delivered(note.id); } catch { /* best-effort advisory */ }
      });
    },
    settled() { return active; },
  };
}
