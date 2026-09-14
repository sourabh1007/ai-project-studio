import type {
  PlanUsage,
  PlanUsageProbe,
  PlanUsageState,
} from './plan-usage-contract.js';
import { parsePlanUsage } from './plan-usage-parser.js';

/**
 * Serves the account's AI-credit budget, captured from the Copilot CLI
 * `/usage` panel.
 *
 * A capture boots a throwaway `copilot` TUI and takes tens of seconds, so
 * {@link PlanUsageService.read} never waits for one: it answers immediately
 * from cache and starts a capture in the background when the cache is empty or
 * stale. Blocking here used to hold an HTTP request open past the client
 * timeout, which surfaced as a status bar that silently showed nothing.
 *
 * Captures are single-flighted so overlapping reads share one probe, and a
 * probe that throws is recorded as an error rather than propagated — a failed
 * quota scrape must never take the backend or a request down with it.
 */
export interface PlanUsageService {
  /** Returns the current state without ever awaiting a fresh capture. */
  read(): PlanUsageState;
  /** Forces a capture, updating the cache; shared when already in flight. */
  refresh(): Promise<PlanUsage | null>;
}

export interface PlanUsageServiceDeps {
  probe: PlanUsageProbe;
  /** Clock, injectable for tests. */
  now: () => Date;
  /** How long a captured snapshot is considered fresh, in milliseconds. */
  ttlMs: number;
  /**
   * Consecutive failed captures tolerated before {@link PlanUsageService.read}
   * reports `unavailable` (when there is no cached snapshot yet). Booting the
   * probe can transiently lose the first race for machine resources against the
   * warm pool, so a single miss stays `capturing` and retries. Defaults to 1,
   * preserving the original "report the first failure" behaviour.
   */
  failureThreshold?: number;
}

const NO_PANEL =
  'The Copilot CLI did not render its /usage panel before the probe timed out.';

export function createPlanUsageService(
  deps: PlanUsageServiceDeps,
): PlanUsageService {
  const failureThreshold = Math.max(1, deps.failureThreshold ?? 1);
  let cached: PlanUsage | null = null;
  let cachedAt = 0;
  let inFlight: Promise<PlanUsage | null> | null = null;
  let lastError: string | null = null;
  let consecutiveFailures = 0;

  const runProbe = async (): Promise<PlanUsage | null> => {
    let text: string | null;
    try {
      text = await deps.probe.capture();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      consecutiveFailures += 1;
      return cached;
    }
    const parsed =
      text === null ? null : parsePlanUsage(text, deps.now().toISOString());
    if (parsed === null) {
      lastError = NO_PANEL;
      consecutiveFailures += 1;
      return cached;
    }
    cached = parsed;
    cachedAt = deps.now().getTime();
    lastError = null;
    consecutiveFailures = 0;
    return parsed;
  };

  const refresh = (): Promise<PlanUsage | null> => {
    if (inFlight) {
      return inFlight;
    }
    const run = runProbe().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };

  return {
    refresh,
    read() {
      const stale = deps.now().getTime() - cachedAt >= deps.ttlMs;
      if (cached === null || stale) {
        // Fire and forget: the caller gets an answer now, and the next read
        // picks up whatever this capture produced.
        void refresh();
      }
      if (cached !== null) {
        return { status: 'ready', usage: cached, error: null };
      }
      // No snapshot yet. A capture is always running at this point. Report a
      // failure only after enough consecutive misses that it is unlikely to be
      // a transient boot race; until then keep saying we are still capturing so
      // the status bar does not flash an error and then recover.
      return lastError === null || consecutiveFailures < failureThreshold
        ? { status: 'capturing', usage: null, error: null }
        : { status: 'unavailable', usage: null, error: lastError };
    },
  };
}