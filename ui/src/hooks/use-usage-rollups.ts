import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../app/api-context.js';
import { usePageSnapshot } from '../app/page-cache.js';
import { calendarUsageWindow, type UsageWindow } from '../lib/usage-window.js';
import type {
  IdeActivityFeed,
  UsageGranularity,
  UsageRollup,
} from '../lib/types.js';

/** A loaded date-window snapshot and its daily/monthly grouping. */
export interface UsageExplorerState {
  granularity: UsageGranularity;
  window: UsageWindow;
  workspace: UsageRollup | null;
  ide: UsageRollup | null;
  activity: IdeActivityFeed | null;
  loading: boolean;
  error: string | null;
  progress?: { completed: number; total: number };
}

/**
 * Loads workspace and IDE usage for the chosen UTC calendar period, grouping
 * years by month and shorter periods by day. Re-fetches whenever the period
 * or `signal` changes so the view stays current as usage is recorded, moved or
 * retained. Rollups include retained (deleted) work within the same window.
 */
export function useUsageExplorer(
  granularity: UsageGranularity,
  signal: number,
): UsageExplorerState {
  const api = useApi();
  const window = useMemo(() => calendarUsageWindow(granularity), [granularity, signal]);
  const grouping = granularity === 'year' ? 'month' : 'day';
  const [cached, saveSnapshot] = usePageSnapshot<UsageExplorerState>(
    `usage:${grouping}:${window.from}:${window.to}`,
  );
  const [state, setState] = useState<UsageExplorerState>(cached ? { ...cached, loading: true } : {
    granularity: grouping,
    window,
    workspace: null,
    ide: null,
    activity: null,
    loading: true,
    error: null,
    progress: { completed: 0, total: 3 },
  });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null, progress: { completed: 0, total: 3 } }));
    let completed = 0;
    const track = <T,>(work: Promise<T>) => work.then((result) => {
      completed += 1;
      if (!cancelled) setState((prev) => ({ ...prev, progress: { completed, total: 3 } }));
      return result;
    });
    void Promise.all([
      track(api.getUsageRollup(grouping, window)),
      track(api.getIdeUsageRollup(grouping, window)),
      track(api.getIdeActivity()),
    ])
      .then(([workspace, ide, activity]) => {
        if (!cancelled) {
          const next: UsageExplorerState = {
            granularity: grouping,
            window,
            workspace,
            ide,
            activity: { records: activity.records.filter((record) => {
              const at = Date.parse(record.capturedAt);
              return at >= Date.parse(window.from) && at < Date.parse(window.to);
            }) },
            loading: false,
            error: null,
            progress: { completed: 3, total: 3 },
          };
          setState(next);
          saveSnapshot(next);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load usage',
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, grouping, window, signal, saveSnapshot]);

  return state;
}
