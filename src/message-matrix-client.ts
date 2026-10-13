import { WorkerMatrixClient } from './worker-matrix-client.js';

export type MessageHistory = {
  since: number;
  heads: () => Record<string, string>;
  save: (heads: Record<string, string>) => void;
};

// The SDK normally advances /sync before emitting messages. Await durable
// inbox writes instead, and fill limited timelines before consuming next_batch.
export class MessageMatrixClient extends WorkerMatrixClient {
  history?: MessageHistory;

  protected override async processSync(raw: any, emitFn?: (type: string, ...args: any[]) => Promise<any>) {
    try {
      const heads = this.history?.heads() ?? {};
      for (const [room, data] of Object.entries<any>(raw.rooms?.join ?? {})) {
        const timeline = data.timeline;
        if (!Array.isArray(timeline?.events)) continue;
        if (timeline.limited && this.history) {
          timeline.events = await fillTimeline(timeline, heads[room], this.history.since, from =>
            this.doRequest('GET', '/_matrix/client/v3/rooms/' + encodeURIComponent(room) + '/messages',
              { from, dir: 'b', limit: 100 }));
        }
      }
      await super.processSync(raw, emitFn);
      for (const [room, data] of Object.entries<any>(raw.rooms?.join ?? {})) {
        const id = data.timeline?.events?.at(-1)?.event_id;
        if (typeof id === 'string') heads[room] = id;
      }
      this.history?.save(heads);
    } catch (error) {
      // The SDK otherwise continues with the new in-memory sync token even
      // when processing fails. Stop so a restart reuses the saved checkpoint.
      this.stop(); this.emit('worker.inbox_failure', error); throw error;
    }
  }
}

export async function fillTimeline(timeline: { events: any[]; prev_batch?: string }, head: string | undefined,
  since: number, page: (from: string) => Promise<{ chunk: any[]; end?: string }>): Promise<any[]> {
  const events = [...timeline.events];
  const ids = new Set(events.map(e => e.event_id));
  if (head && ids.has(head)) return events;
  let from = timeline.prev_batch;
  const tokens = new Set<string>();
  while (from) {
    if (tokens.has(from)) throw new Error('Matrix history pagination made no progress. Restart to retry recovery.');
    tokens.add(from);
    const result = await page(from);
    if (!Array.isArray(result.chunk)) throw new Error('Invalid Matrix history page.');
    const earlier: any[] = [];
    let reached = false;
    for (const event of result.chunk) {
      if (event.event_id === head || (!head && Number.isFinite(event.origin_server_ts) && event.origin_server_ts < since)) {
        reached = true; break;
      }
      if (event.event_id && !ids.has(event.event_id)) { earlier.push(event); ids.add(event.event_id); }
    }
    events.unshift(...earlier.reverse());
    if (reached || !result.chunk.length) break;
    from = result.end;
  }
  return events;
}
