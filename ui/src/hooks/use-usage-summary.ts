import { useEffect, useRef, useState } from 'react';
import { useApi } from '../app/api-context.js';
import type { UsageSummary } from '../lib/types.js';

const REFRESH_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** One throttled workspace request, not one query per explorer row. */
export function useUsageSummary(revision: string | number) {
  const api = useApi();
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  const refresh = useRef<(() => void) | null>(null);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let completedRevision: string | number | undefined;
    let failed = false;
    const load = async (force = false) => {
      if (disposed || controller || document.visibilityState === 'hidden') return;
      if (!force && !failed && completedRevision === latestRevision.current) return;
      const requestedRevision = latestRevision.current;
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        request.abort();
      }, REQUEST_TIMEOUT_MS);
      setLoading(true);
      try {
        const snapshot = await api.getUsageSummary({ signal: request.signal });
        if (disposed) return;
        setData(snapshot);
        setError(null);
        completedRevision = requestedRevision;
        failed = false;
      } catch (cause) {
        if (disposed) return;
        failed = true;
        setError(timedOut ? 'Usage summary timed out. Retry to refresh.'
          : cause instanceof Error ? cause.message : 'Usage summary could not be loaded.');
      } finally {
        clearTimeout(timeout);
        controller = null;
        if (!disposed) setLoading(false);
      }
    };
    const retry = () => { void load(true); };
    refresh.current = retry;
    const visible = () => {
      if (document.visibilityState !== 'hidden') retry();
    };
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', retry);
    void load();
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', retry);
      refresh.current = null;
    };
  }, [api]);

  return { data, error, loading, retry: () => refresh.current?.() };
}
