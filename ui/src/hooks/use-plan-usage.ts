import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type { PlanUsageState } from '../lib/types.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How often to re-ask while the backend has no snapshot yet. Capturing one
 * boots a Copilot TUI and takes tens of seconds, so the settled multi-minute
 * cadence would leave the status bar blank for the whole first refresh window.
 * The read is cheap (the backend never blocks on the capture), so polling fast
 * until the first snapshot lands costs nothing.
 */
const PENDING_INTERVAL_MS = 5000;

/**
 * Fetches the signed-in plan's AI-credit budget (used / total / available /
 * reset). The backend scrapes this from the CLI `/usage` panel and caches it,
 * so the hook simply polls. Once a snapshot exists the cadence mirrors the
 * configured `planUsage.refreshMinutes` setting (read once on mount) so a
 * single control governs both the backend cache lifetime and this UI refresh.
 *
 * A failed request is reported rather than swallowed: the status bar showed
 * nothing at all when this went wrong, which read as a missing feature instead
 * of a broken one.
 */
export function usePlanUsage(): PlanUsageState {
  const api = useApi();
  const [state, setState] = useState<PlanUsageState>({
    status: 'capturing',
    usage: null,
    error: null,
  });
  const [intervalMs, setIntervalMs] = useState(DEFAULT_INTERVAL_MS);

  useEffect(() => {
    let cancelled = false;
    void api
      .getConfig()
      .then((cfg) => {
        const minutes = Number(cfg.current?.planUsage?.refreshMinutes);
        if (!cancelled && Number.isFinite(minutes) && minutes >= 1) {
          setIntervalMs(minutes * 60 * 1000);
        }
      })
      .catch(() => {
        /* fall back to the default cadence if config is unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const settled = state.usage !== null;

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void api
        .getPlanUsage()
        .then((next) => {
          if (!cancelled && next) {
            setState(next);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState((prev) =>
            prev.usage !== null
              ? prev
              : {
                  status: 'unavailable',
                  usage: null,
                  error: error instanceof Error ? error.message : String(error),
                },
          );
        });
    };
    load();
    const timer = setInterval(
      load,
      settled ? intervalMs : PENDING_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, intervalMs, settled]);

  return state;
}