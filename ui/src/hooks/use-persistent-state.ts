import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readPersisted,
  writePersisted,
  type KeyValueStore,
} from '../lib/persisted-state.js';

interface Options<T> {
  /** Validates a persisted value before it is trusted; defaults to accept-all. */
  validate?: (value: unknown) => value is T;
  /** Normalizes a value before storing/using it (e.g. clamp a width). */
  normalize?: (value: T) => T;
  /** Storage to use; defaults to `window.localStorage` when available. */
  store?: KeyValueStore;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const acceptAll = <T,>(value: unknown): value is T => value !== undefined;

/**
 * A `useState` that transparently persists to `localStorage` under `key`. Reads
 * the stored value on first render (validated + normalized) and writes on every
 * change. All storage access is best-effort via the pure `persisted-state`
 * helpers, so it degrades gracefully when storage is unavailable.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  options: Options<T> = {},
): [T, (next: T | ((prev: T) => T)) => void] {
  const storeRef = useRef<KeyValueStore | null>(options.store ?? defaultStore());
  const validate = options.validate ?? acceptAll<T>;
  const normalize = options.normalize;

  const [value, setValue] = useState<T>(() => {
    const store = storeRef.current;
    const loaded = store
      ? readPersisted(store, key, validate, initial)
      : initial;
    return normalize ? normalize(loaded) : loaded;
  });

  useEffect(() => {
    const store = storeRef.current;
    if (store) {
      writePersisted(store, key, value);
    }
  }, [key, value]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function'
            ? (next as (prev: T) => T)(prev)
            : next;
        return normalize ? normalize(resolved) : resolved;
      });
    },
    [normalize],
  );

  return [value, set];
}
