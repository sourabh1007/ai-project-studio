import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type { WorkspaceStats } from '../lib/types.js';

/**
 * Fetches authoritative persisted workspace stats (usage totals + session
 * counts), re-fetching whenever `signal` changes. The signal is derived from
 * the live stream so the status bar stays fresh as new usage/session events
 * arrive, while always reflecting the persisted source of truth (the live SSE
 * feed does not replay history and is incomplete after reloads).
 */
export function useWorkspaceStats(signal: number): WorkspaceStats | null {
  const api = useApi();
  const [stats, setStats] = useState<WorkspaceStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getWorkspaceStats()
      .then((next) => {
        if (!cancelled) {
          setStats(next);
        }
      })
      .catch(() => {
        /* transient fetch errors are non-fatal for the status bar */
      });
    return () => {
      cancelled = true;
    };
  }, [api, signal]);

  return stats;
}
