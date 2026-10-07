import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EngineReport } from './bot-status.js';
import type { CheckpointState } from './context-checkpoints.js';
import { AGENT_TRIGGER, NOTICE, type MatrixEvent } from './bridge.js';

export type Session = { codex?: string; codexInstructionsHash?: string; claude?: string; grok?: string; codexReport?: EngineReport; claudeReport?: EngineReport; codexCheckpoint?: CheckpointState; claudeCheckpoint?: CheckpointState };
type Pending = { room: string; event: MatrixEvent; feedback: boolean };
type Data = { version: 1; sessions: Record<string, Session>; seen: string[]; pending?: Record<string, Pending[]> };

export class State {
  private data: Data;
  constructor(private file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, sessions: {}, seen: [] };
    if (this.data.version !== 1 || !this.data.sessions || !Array.isArray(this.data.seen)) {
      throw new Error('Invalid state file. Restore it from a backup before restarting.');
    }
  }
  session(key: string): Session { return { ...this.data.sessions[key] }; }
  update(key: string, value: Session) {
    this.data.sessions[key] = { ...this.session(key), ...value };
    this.save();
  }
  reset(key: string) { delete this.data.sessions[key]; this.save(); }
  enqueue(bot: string, message: Pending): boolean {
    const queue = (this.data.pending ??= {})[bot] ??= [];
    if (queue.length >= 20) return false;
    queue.push(message); this.save(); return true;
  }
  dequeueBatch(bot: string): Pending[] {
    const queue = this.data.pending?.[bot];
    if (!queue?.length) return [];
    const first = queue[0];
    // Peer mentions and other connector notices are never merged with human text.
    const scope = (m: Pending) => JSON.stringify([m.room, m.event.sender,
      m.event.content?.['m.relates_to']?.rel_type === 'm.thread' ? m.event.content['m.relates_to'].event_id : null,
      m.event.content?.[AGENT_TRIGGER] || m.event.content?.[NOTICE] ? m.event.event_id : null]);
    const batch: Pending[] = [];
    let size = 0;
    // Preserve admission order across rooms. Only adjacent messages in the
    // selected conversation are combined, up to one prompt's input budget.
    while (queue.length && scope(queue[0]) === scope(first)) {
      const nextSize = queue[0].event.content?.body?.length ?? 0;
      if (batch.length && size + nextSize > 12_000) break;
      batch.push(queue.shift()!); size += nextSize;
    }
    this.save(); return batch;
  }
  queued(bot: string): number { return this.data.pending?.[bot]?.length ?? 0; }
  cancelQueued(bot: string, room: string, sender: string, thread: string | null): number {
    const queue = this.data.pending?.[bot];
    if (!queue) return 0;
    const keep = queue.filter(m => {
      const relation = m.event.content?.['m.relates_to'];
      const targetThread = relation?.rel_type === 'm.thread' ? relation.event_id : null;
      return m.room !== room || m.event.sender !== sender || targetThread !== thread;
    });
    this.data.pending![bot] = keep; this.save(); return queue.length - keep.length;
  }
  claim(id: string) {
    if (this.data.seen.includes(id)) return false;
    this.data.seen.push(id);
    this.data.seen = this.data.seen.slice(-10_000);
    this.save();
    return true;
  }
  private save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
