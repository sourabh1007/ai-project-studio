interface DrainingPool {
  resize(size: number): void;
  stats(): { live: number };
  close(): void;
}

/** Stop replenishment immediately; busy turns drain while failed retirements retry. */
export function drainMetaPool(deps: {
  pool: DrainingPool;
  onDrained(): void;
  onError(error: unknown): void;
  retryMs?: number;
}): void {
  const step = (): boolean => {
    try {
      deps.pool.resize(0);
      if (deps.pool.stats().live !== 0) return false;
      deps.pool.close();
      return true;
    } catch (error) {
      deps.onError(error);
      return false;
    }
  };
  if (step()) {
    deps.onDrained();
    return;
  }
  const timer = setInterval(() => {
    if (step()) {
      clearInterval(timer);
      deps.onDrained();
    }
  }, deps.retryMs ?? 700);
  timer.unref();
}
