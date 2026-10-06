import { SERVICE } from './bridge.js';
import { PublicError } from './errors.js';

export type CompactionPhase = 'started' | 'completed' | 'unconfirmed';

// Per running backend call. Claude repeats its compacting status as a heartbeat.
// Completion without an observed start may be replayed history, not new work.
export function compactionNotices(send?: (phase: CompactionPhase) => Promise<void>) {
  const started = new Set<string>(), finished = new Set<string>();
  let pending = Promise.resolve();
  const emit = (phase: CompactionPhase) => {
    // Delivery failures must not interrupt the model or cause an automatic resend.
    pending = pending.then(() => send?.(phase)).then(() => {}, () => {});
  };
  return {
    start(id: string) {
      if (started.has(id) || finished.has(id)) return;
      started.add(id); emit('started');
    },
    complete(id: string) {
      if (!started.delete(id)) return;
      finished.add(id); emit('completed');
    },
    async close() {
      for (const id of started) { finished.add(id); emit('unconfirmed'); }
      started.clear();
      await pending;
    },
  };
}

const messages: Record<CompactionPhase, string> = {
  started: 'Riftjack: context compaction started.',
  completed: 'Riftjack: context compaction completed.',
  unconfirmed: 'Riftjack: the agent run ended without confirmation that context compaction completed.',
};

// The caller supplies a trusted DM destination, never a path/room from model output.
export async function sendCompactionNotice(phase: CompactionPhase, room: string, transport: {
  allowed(room: string): Promise<boolean>; stopping(): boolean;
  send(room: string, content: { msgtype: 'm.notice'; body: string; 'm.mentions': object; [SERVICE]: boolean }): Promise<unknown>;
}) {
  if (transport.stopping() || !(await transport.allowed(room)) || transport.stopping()) {
    throw new PublicError('Compaction notice withheld because private room access changed or the connector is stopping.');
  }
  await transport.send(room, { msgtype: 'm.notice', body: messages[phase], 'm.mentions': {}, [SERVICE]: true });
}
