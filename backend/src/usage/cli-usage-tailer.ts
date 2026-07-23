import type { UsageEvent } from './usage-contract.js';

/**
 * Minimal timer contract so the poll loop is unit-testable without real timers.
 * The handle is opaque; the default adapter uses Node's timer functions.
 */
export interface TailScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultScheduler: TailScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface CliUsageTailerDeps {
  /** Returns ALL usage events for the session so far, in stable order. */
  read: () => UsageEvent[];
  /** Invoked once for each newly-observed usage event. */
  onUsage: (event: UsageEvent) => void;
  /** Poll cadence in milliseconds. */
  intervalMs: number;
  /** Injectable scheduler; defaults to Node timers. */
  scheduler?: TailScheduler;
}

export interface CliUsageTailer {
  /** Drains immediately, then polls on the configured interval. */
  start(): void;
  /** Stops polling. Safe to call before start or multiple times. */
  stop(): void;
  /** Emits any events appended since the last drain (for a final flush). */
  drain(): void;
}

/**
 * Polls a session's usage source (the CLI's own store, which this app cannot
 * receive push notifications from under SQLite WAL) and emits each newly
 * appended {@link UsageEvent} exactly once, tracked by count. This drives the
 * live per-session credit/token/model meter for interactive terminal sessions.
 */
export function createCliUsageTailer(deps: CliUsageTailerDeps): CliUsageTailer {
  const scheduler = deps.scheduler ?? defaultScheduler;
  let emitted = 0;
  let handle: unknown;

  const drain = (): void => {
    const events = deps.read();
    for (let i = emitted; i < events.length; i += 1) {
      deps.onUsage(events[i]);
    }
    if (events.length > emitted) {
      emitted = events.length;
    }
  };

  return {
    start() {
      drain();
      handle = scheduler.setInterval(drain, deps.intervalMs);
    },
    stop() {
      if (handle !== undefined) {
        scheduler.clearInterval(handle);
        handle = undefined;
      }
    },
    drain,
  };
}
