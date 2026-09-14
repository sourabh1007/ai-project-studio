import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type {
  IdeActivityFeed,
  UsageGranularity,
  UsageRollup,
} from '../lib/types.js';

/** The consolidated usage the Usage view renders for a chosen granularity. */
export interface UsageExplorerState {
  granularity: UsageGranularity;
  workspace: UsageRollup | null;
  ide: UsageRollup | null;
  activity: IdeActivityFeed | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads the workspace and IDE-metasession usage rollups plus the recent IDE
 * activity feed for a chosen granularity. Re-fetches whenever the granularity
 * or `signal` changes so the view stays current as usage is recorded, moved or
 * retained. Both rollups already fold in retained (deleted) work and all
 * metasession overhead, so totals here reconcile with the plan budget.
 */
export function useUsageExplorer(
  granularity: UsageGranularity,
  signal: number,
): UsageExplorerState {
  const api = useApi();
  const [state, setState] = useState<UsageExplorerState>({
    granularity,
    workspace: null,
    ide: null,
    activity: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, granularity, loading: true, error: null }));
    void Promise.all([
      api.getUsageRollup(granularity),
      api.getIdeUsageRollup(granularity),
      api.getIdeActivity(),
    ])
      .then(([workspace, ide, activity]) => {
        if (!cancelled) {
          setState({
            granularity,
            workspace,
            ide,
            activity,
            loading: false,
            error: null,
          });
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
  }, [api, granularity, signal]);

  return state;
}
