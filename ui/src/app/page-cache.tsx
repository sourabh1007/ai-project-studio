import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

interface Snapshot {
  value: unknown;
  savedAt: number;
}

const PageCache = createContext<Map<string, Snapshot> | null>(null);
export const PageVisibility = createContext(true);

/** Navigation snapshots are memory-only, bounded, and isolated to an API client. */
export function PageCacheProvider({ scope, children }: { scope: object; children: ReactNode }) {
  const cache = useMemo(() => new Map<string, Snapshot>(), [scope]);
  return <PageCache.Provider value={cache}>{children}</PageCache.Provider>;
}

export function usePageSnapshot<T>(key?: string) {
  const cache = useContext(PageCache);
  const snapshot = key ? cache?.get(key) : undefined;
  const value = snapshot && Date.now() - snapshot.savedAt < 60_000
    ? snapshot.value as T : null;
  const save = useCallback((data: T) => {
    if (!cache || !key) return;
    cache.delete(key);
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, { value: data, savedAt: Date.now() });
  }, [cache, key]);
  const invalidate = useCallback(() => {
    if (key) cache?.delete(key);
  }, [cache, key]);
  return [value, save, invalidate] as const;
}
