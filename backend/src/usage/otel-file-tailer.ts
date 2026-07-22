import type { UsageEvent } from './usage-contract.js';

/** Minimal file-watcher contract; the real chokidar adapter lives at the root. */
export interface FileWatcher {
  onChange(cb: () => void | Promise<void>): void;
  close(): Promise<void>;
}

export type WatcherFactory = (path: string) => FileWatcher;
export type ReadUsageEvents = (path: string) => Promise<UsageEvent[]>;

export interface UsageTailerDeps {
  watch: WatcherFactory;
  readEvents: ReadUsageEvents;
  onUsage: (event: UsageEvent) => void;
}

export interface UsageTailer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Tails a session's OTel usage file and emits each newly-appended UsageEvent
 * exactly once (tracked by count), enabling the live per-session credit meter.
 */
export function createUsageTailer(
  filePath: string,
  deps: UsageTailerDeps,
): UsageTailer {
  let emitted = 0;
  let watcher: FileWatcher | undefined;

  const drain = async (): Promise<void> => {
    const events = await deps.readEvents(filePath);
    for (let i = emitted; i < events.length; i += 1) {
      deps.onUsage(events[i]);
    }
    if (events.length > emitted) {
      emitted = events.length;
    }
  };

  return {
    async start() {
      watcher = deps.watch(filePath);
      watcher.onChange(drain);
      await drain();
    },
    async stop() {
      if (watcher) {
        await watcher.close();
        watcher = undefined;
      }
    },
  };
}
