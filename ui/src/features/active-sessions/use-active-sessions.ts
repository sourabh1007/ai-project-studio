import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveSessionDebug, ActiveSessionsApi, ActiveSessionsSnapshot } from './active-session-types.js';

/** One cadence for all instances; only the selected debugger reads output. */
export function useActiveSessions(api: ActiveSessionsApi, selected: string | null, revision = 0) {
  const [snapshot, setSnapshot] = useState<ActiveSessionsSnapshot | null>(null);
  const [debug, setDebug] = useState<ActiveSessionDebug | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const previousRevision = useRef(revision);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (previousRevision.current === revision) return;
    const timer = setTimeout(() => {
      previousRevision.current = revision;
      refresh();
    }, 150);
    return () => clearTimeout(timer);
  }, [revision, refresh]);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let interval = 3000;
    setDebug(null);
    setDebugError(null);
    async function poll() {
      if (cancelled || pending || document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      pending = true;
      controller = new AbortController();
      const options = { signal: controller.signal };
      try {
        const next = await api.getActiveSessions(options);
        if (cancelled) return;
        interval = Math.max(1000, Math.min(next.pollMs, 60000));
        setSnapshot(next); setError(null);
        if (selected) {
          try {
            const result = await api.getActiveSessionDebug(selected, options);
            if (!cancelled) { setDebug(result); setDebugError(null); }
          } catch {
            if (!cancelled) setDebugError('Live debug activity is unavailable. Retry to reconnect.');
          }
        }
      } catch {
        if (!cancelled) setError('Active sessions are unavailable. The last snapshot may be stale.');
      } finally {
        pending = false;
        if (!cancelled) timer = setTimeout(() => void poll(), interval);
      }
    }
    void poll();
    const visible = () => {
      if (document.visibilityState !== 'hidden') void poll();
      else { clearTimeout(timer); controller?.abort(); }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [api, selected, refreshKey]);
  return { snapshot, debug, error, debugError, refresh };
}
