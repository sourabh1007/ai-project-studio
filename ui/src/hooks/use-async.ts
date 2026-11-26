import { useCallback, useContext, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useStartupPending } from '../app/desktop-lifecycle.js';
import { PageVisibility, usePageSnapshot } from '../app/page-cache.js';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** The raw caught value, preserved so callers can classify it (HTTP status, etc). */
  cause: unknown;
  reload: () => void;
  updateData: (update: SetStateAction<T | null>) => void;
}

/** Runs an async loader on mount and whenever a dependency changes. */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  cacheKey?: string,
): AsyncState<T> {
  const visible = useContext(PageVisibility);
  const [snapshot, saveSnapshot, invalidateSnapshot] = usePageSnapshot<T>(cacheKey);
  const [data, setData] = useState<T | null>(snapshot);
  const [loading, setLoading] = useState(true);
  useStartupPending(loading && visible && data === null);
  const [error, setError] = useState<string | null>(null);
  const [cause, setCause] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const running = useRef(false);
  const queued = useRef(false);
  const generation = useRef(0);

  const updateData = useCallback((update: SetStateAction<T | null>) => {
    generation.current += 1;
    running.current = false;
    queued.current = false;
    invalidateSnapshot();
    setData(update);
    setLoading(false);
    setError(null);
    setCause(null);
  }, [invalidateSnapshot]);

  const reload = useCallback(() => {
    if (running.current) {
      queued.current = true;
      return;
    }
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!visible) {
      running.current = false;
      return;
    }
    let active = true;
    const run = ++generation.current;
    running.current = true;
    setLoading(true);
    setError(null);
    setCause(null);
    // A loader that throws synchronously must not escape the effect: that
    // would strand the view on its skeleton with no error and no way to retry.
    let started: Promise<T>;
    try {
      started = loader();
    } catch (err: unknown) {
      started = Promise.reject(err);
    }
    started
      .then((result) => {
        if (active && generation.current === run) {
          setData(result);
          saveSnapshot(result);
        }
      })
      .catch((err: unknown) => {
        if (active && generation.current === run) {
          setError(err instanceof Error ? err.message : String(err));
          setCause(err);
        }
      })
      .finally(() => {
        if (generation.current !== run) return;
        running.current = false;
        if (!active) return;
        setLoading(false);
        if (queued.current) {
          queued.current = false;
          setNonce((n) => n + 1);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, visible, saveSnapshot]);

  return { data, loading, error, cause, reload, updateData };
}
