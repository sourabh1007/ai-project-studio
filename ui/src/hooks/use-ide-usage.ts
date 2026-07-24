import { useEffect, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type { IdeUsage } from '../lib/types.js';

/**
 * Fetches the IDE's own AI (meta-session) usage — the assistant overhead spent
 * on summaries, task plans, etc. Re-fetches whenever `signal` changes so the
 * indicator stays fresh as new usage events arrive, always reflecting the
 * persisted source of truth. Transient fetch errors are non-fatal.
 */
export function useIdeUsage(signal: number): IdeUsage | null {
  const api = useApi();
  const [usage, setUsage] = useState<IdeUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getIdeUsage()
      .then((next) => {
        if (!cancelled) {
          setUsage(next);
        }
      })
      .catch(() => {
        /* transient fetch errors are non-fatal for the status bar */
      });
    return () => {
      cancelled = true;
    };
  }, [api, signal]);

  return usage;
}
