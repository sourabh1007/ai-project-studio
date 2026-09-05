import type { PlanUsage, PlanUsageProbe } from './plan-usage-contract.js';
import { parsePlanUsage } from './plan-usage-parser.js';

/**
 * Serves the account's AI-credit budget, captured on demand from the Copilot
 * CLI `/usage` panel. Because each capture spins up a short-lived `copilot`
 * process (seconds), results are cached: a fresh snapshot is returned as-is, a
 * stale one is returned immediately while a refresh runs in the background, and
 * the very first read awaits a capture. Captures are single-flighted so
 * overlapping reads share one probe.
 */
export interface PlanUsageService {
  /** Returns the latest budget snapshot, refreshing lazily when stale. */
  read(): Promise<PlanUsage | null>;
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

export function createPlanUsageService(
  deps: PlanUsageServiceDeps,
): PlanUsageService {
  let cached: PlanUsage | null = null;
  let cachedAt = 0;
  let inFlight: Promise<PlanUsage | null> | null = null;

  const runProbe = async (): Promise<PlanUsage | null> => {
    const text = await deps.probe.capture();
    if (text === null) {
      return cached;
    }
    const parsed = parsePlanUsage(text, deps.now().toISOString());
    if (parsed === null) {
      return cached;
    }
    cached = parsed;
    cachedAt = deps.now().getTime();
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
      if (cached === null) {
        return refresh();
      }
      const fresh = deps.now().getTime() - cachedAt < deps.ttlMs;
      if (!fresh) {
        void refresh();
      }
      return Promise.resolve(cached);
    },
  };
}
