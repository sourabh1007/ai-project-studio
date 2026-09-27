import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { AppResourceSnapshot } from './resource-types.js';

export function useResourceMonitor(expanded: boolean) {
  const api = useApi();
  const [snapshot, setSnapshot] = useState<AppResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const request = async () => {
      try {
        const next = await Promise.resolve().then(() => api.getAppResources());
        if (mounted.current) { setSnapshot(next); setError(null); }
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'App resource measurements are unavailable.');
      } finally {
        if (mounted.current) setLoading(false);
        inFlight.current = null;
      }
    };
    inFlight.current = request();
    return inFlight.current;
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState !== 'hidden') await refresh();
      if (!cancelled) timer = setTimeout(poll, expanded ? 1000 : 10_000);
    };
    void poll();
    const onVisible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      mounted.current = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, expanded]);
  return { snapshot, error, loading, refresh };
}
