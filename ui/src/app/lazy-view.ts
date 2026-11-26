import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface PreloadableView<P> {
  Component: LazyExoticComponent<ComponentType<P>>;
  /** Fetch the view's code ahead of navigation; safe to call repeatedly. */
  preload(): Promise<void>;
}

/**
 * React.lazy that can be warmed ahead of time. Once the module has loaded, the
 * lazy factory returns a synchronously-resolving thenable, which React 18
 * treats as already resolved: navigating to a preloaded view renders on the
 * first pass instead of flashing a Suspense fallback.
 */
export function preloadableView<M, P>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): PreloadableView<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  const preload = (): Promise<void> => {
    pending ??= load().then(
      (module) => { loaded = pick(module); },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  const Component = lazy(() => {
    const ready = loaded;
    if (ready) {
      const resolved = { then: (resolve: (value: { default: ComponentType<P> }) => void) => resolve({ default: ready }) };
      return resolved as unknown as Promise<{ default: ComponentType<P> }>;
    }
    return preload().then(() => ({ default: loaded as ComponentType<P> }));
  });
  return { Component, preload };
}

type IdleHandle = { cancel(): void };

function whenIdle(callback: () => void): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 2_000 });
    return { cancel: () => window.cancelIdleCallback(id) };
  }
  const id = window.setTimeout(callback, 200);
  return { cancel: () => window.clearTimeout(id) };
}

/**
 * Warm the given preloaders one at a time during idle periods, after an
 * initial delay so startup work and the first view keep priority. Failures are
 * ignored here; the real navigation retries and reports through its boundary.
 */
export function warmViewsWhenIdle(
  preloaders: ReadonlyArray<() => Promise<void>>,
  delayMs = 1_200,
): () => void {
  const queue = [...preloaders];
  let cancelled = false;
  let idle: IdleHandle | null = null;
  const next = () => {
    idle = null;
    const preload = queue.shift();
    if (cancelled || !preload) return;
    void preload().catch(() => undefined).then(() => {
      if (!cancelled) idle = whenIdle(next);
    });
  };
  const start = window.setTimeout(() => { idle = whenIdle(next); }, delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(start);
    idle?.cancel();
  };
}
