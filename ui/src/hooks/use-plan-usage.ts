import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type { PlanUsage } from '../lib/types.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Fetches the signed-in plan's AI-credit budget (used / total / available /
 * reset). The backend scrapes this from the CLI `/usage` panel and caches it,
 * so the hook simply polls. The poll cadence mirrors the configured
 * `planUsage.refreshMinutes` setting (read once on mount) so a single control
 * governs both the backend cache lifetime and this UI refresh. The first
 * capture can take a few seconds, so `null` is expected briefly, and transient
 * fetch errors are non-fatal for the status bar.
 */
export function usePlanUsage(): PlanUsage | null {
  const api = useApi();
  const [usage, setUsage] = useState<PlanUsage | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void api
        .getPlanUsage()
        .then((next) => {
          if (!cancelled && next !== null) {
            setUsage(next);
          }
        })
        .catch(() => {
          /* transient fetch errors are non-fatal for the status bar */
        });
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, intervalMs]);

  return usage;
}
