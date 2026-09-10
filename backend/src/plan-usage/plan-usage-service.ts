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
}

const NO_PANEL =
  'The Copilot CLI did not render its /usage panel before the probe timed out.';

export function createPlanUsageService(
  deps: PlanUsageServiceDeps,
): PlanUsageService {
  let cached: PlanUsage | null = null;
  let cachedAt = 0;
  let inFlight: Promise<PlanUsage | null> | null = null;
  let lastError: string | null = null;

  const runProbe = async (): Promise<PlanUsage | null> => {
    let text: string | null;
    try {
      text = await deps.probe.capture();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return cached;
    }
    const parsed =
      text === null ? null : parsePlanUsage(text, deps.now().toISOString());
    if (parsed === null) {
      lastError = NO_PANEL;
      return cached;
    }
    cached = parsed;
    cachedAt = deps.now().getTime();
    lastError = null;
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
      // No snapshot yet. A capture is always running at this point, so report
      // the failure only once one has actually failed.
      return lastError === null
        ? { status: 'capturing', usage: null, error: null }
        : { status: 'unavailable', usage: null, error: lastError };
    },
  };
}