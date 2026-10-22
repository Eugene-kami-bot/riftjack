import { MatrixClient } from '@vector-im/matrix-bot-sdk';

type FailedDecryption = { room: string; event: string };
const FAILED_DECRYPTIONS = 'riftjack.worker.failed_decryptions.v1';

// Unlike model tasks, durable inbox writes must finish before saving /sync's
// next_batch. Failures keep the previous checkpoint on disk for restart replay.
export class WorkerMatrixClient extends MatrixClient {
  inbox?: (room: string, event: any) => Promise<void>;
  private failures?: FailedDecryption[];

  private async loadFailures() {
    if (this.failures) return this.failures;
    const saved = await Promise.resolve(this.storageProvider.readValue(FAILED_DECRYPTIONS));
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' ||
      typeof (item as FailedDecryption).room !== 'string' || !(item as FailedDecryption).room.startsWith('!') ||
      typeof (item as FailedDecryption).event !== 'string' || !(item as FailedDecryption).event.startsWith('$'))) {
      throw new Error('Invalid failed-decryption journal; restore Matrix storage instead of discarding it.');
    }
    return this.failures = parsed as FailedDecryption[];
  }

  private async saveFailures() {
    await Promise.resolve(this.storageProvider.storeValue(FAILED_DECRYPTIONS, JSON.stringify(this.failures)));
  }

  protected async rememberFailedDecryption(room: string, event: any) {
    if (!room.startsWith('!') || typeof event?.event_id !== 'string' || !event.event_id.startsWith('$')) return;
    const failures = await this.loadFailures();
    if (failures.some(item => item.room === room && item.event === event.event_id)) return;
    failures.push({ room, event: event.event_id });
    if (failures.length > 1000) failures.splice(0, failures.length - 1000);
    await this.saveFailures();
  }

  protected async retryFailedDecryptions() {
    const failures = await this.loadFailures();
    if (!failures.length || !this.inbox) return;
    const completed = new Set<string>();
    for (const item of failures.slice(0, 50)) {
      try {
        const found: any = await this.getEvent(item.room, item.event);
        const event = found?.raw ?? found;
        if (event?.type === 'm.room.message' || event?.type === 'm.reaction') await this.inbox(item.room, event);
        completed.add(JSON.stringify(item));
      } catch {
        // A room key can arrive in a later /sync. Keep the durable reference.
      }
    }
    if (completed.size) {
      this.failures = failures.filter(item => !completed.has(JSON.stringify(item)));
      await this.saveFailures();
    }
  }

  protected override async processSync(raw: any, emitFn?: (type: string, ...args: any[]) => Promise<any>) {
    const pendingBefore = (await this.loadFailures()).length;
    await super.processSync(raw, async (type, ...args) => {
      if (type === 'room.failed_decryption') await this.rememberFailedDecryption(args[0], args[1]);
      await emitFn?.(type, ...args);
    });
    // Room keys arrive as to-device events. Also retry once after restart in
    // case the key was stored before the failed-event journal was reopened.
    if (pendingBefore || raw?.to_device?.events?.length) await this.retryFailedDecryptions();
  }

  protected override async startSyncInternal() {
    this.persistTokenAfterSync = true;
    return this.startSync(async (type, ...args) => {
      if (type === 'room.message' || (type === 'room.event' && args[1]?.type === 'm.reaction')) {
        try { await this.inbox?.(args[0], args[1]); }
        catch (error) { this.stop(); this.emit('worker.inbox_failure', error); throw error; }
      }
      this.emit(type, ...args);
    });
  }
}
