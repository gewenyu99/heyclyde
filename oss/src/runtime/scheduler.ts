// In-process periodic task runner replacing cloud cron schedules and waitUntil hooks.
import type { MemoryStore } from "../store/memory-store.ts";
import type { ClydeConfig } from "./config.ts";

export class LocalScheduler {
  private readonly store: MemoryStore;
  private readonly config: ClydeConfig;
  private timers: ReturnType<typeof setInterval>[] = [];
  private inFlight = new Set<string>();
  private stopped = false;

  constructor(store: MemoryStore, config: ClydeConfig) {
    this.store = store;
    this.config = config;
  }

  private async runOnce(name: string, fn: () => Promise<unknown>): Promise<void> {
    if (this.stopped || this.inFlight.has(name)) return;
    this.inFlight.add(name);
    try {
      await fn();
    } catch (err) {
      console.error(`[scheduler:${name}]`, err);
    } finally {
      this.inFlight.delete(name);
    }
  }

  start(): void {
    const embedMs = Math.max(0, this.config.ranking.embed_sync_interval_sec) * 1000;
    if (embedMs > 0) {
      const t = setInterval(() => {
        void this.runOnce("embed-sync", () => this.store.syncEmbeddings());
      }, embedMs);
      t.unref?.();
      this.timers.push(t);
    }

    const learnMs = Math.max(0, this.config.ranking.learn_interval_sec) * 1000;
    if (learnMs > 0) {
      const t = setInterval(() => {
        void this.runOnce("learn", () => this.store.learn());
      }, learnMs);
      t.unref?.();
      this.timers.push(t);
    }

    // Periodic hygiene: quest lease expiry, expired message purge, stale uploads, and old events.
    const maintenanceMs = 60_000;
    const m = setInterval(() => {
      void this.runOnce("maintenance", () => this.store.runMaintenance(this.config.ranking.event_retention_days));
    }, maintenanceMs);
    m.unref?.();
    this.timers.push(m);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
