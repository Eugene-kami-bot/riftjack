// Deliver configuration warnings once per process to an available owner DM.
// Keep undeliverable warnings pending, but never retry an uncertain send.
export class AudioConfigurationWarnings {
  private pending = new Set<string>();
  private seen = new Set<string>();
  add(message: string): void {
    if (!this.seen.has(message)) {
      this.seen.add(message);
      this.pending.add(message);
    }
  }
  async deliver(targets: { allowed(): Promise<boolean>; send(message: string): Promise<unknown> }[]): Promise<void> {
    for (const message of this.pending) {
      for (const target of targets) {
        if (!await target.allowed()) continue;
        this.pending.delete(message);
        await target.send(message);
        break;
      }
    }
  }
}
