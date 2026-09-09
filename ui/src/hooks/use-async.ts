import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** The raw caught value, preserved so callers can classify it (HTTP status, etc). */
  cause: unknown;
  reload: () => void;
}

/** Runs an async loader on mount and whenever a dependency changes. */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cause, setCause] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const running = useRef(false);
  const queued = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(() => {
    if (running.current) {
      queued.current = true;
      return;
    }
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const run = ++generation.current;
    running.current = true;
    setLoading(true);
    setError(null);
    setCause(null);
    loader()
      .then((result) => {
        if (active) {
          setData(result);
        }
      })
      .catch((err: unknown) => {
        if (active) {
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
  }, [...deps, nonce]);

  return { data, loading, error, cause, reload };
}
