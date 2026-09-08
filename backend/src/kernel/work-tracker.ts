export interface WorkTracker<Key> {
  own<T>(key: Key, run: () => Promise<T>): Promise<T>;
  keys(): ReadonlySet<Key>;
  waitForIdle(timeoutMs: number, matches?: (key: Key) => boolean): Promise<boolean>;
}

/** Tracks settlement, not cancellation requests, including persistence after exit. */
export function createWorkTracker<Key>(): WorkTracker<Key> {
  const pending = new Map<Promise<unknown>, Key>();
  const waiters = new Set<() => void>();
  const release = (work: Promise<unknown>) => {
    pending.delete(work);
    for (const notify of [...waiters]) notify();
  };

  return {
    own<T>(key: Key, run: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(run).then(
        (value) => {
          release(work);
          return value;
        },
        (error: unknown) => {
          release(work);
          throw error;
        },
      );
      pending.set(work, key);
      // A cancelled caller may stop awaiting; the original promise still rejects.
      void work.catch(() => {});
      return work;
    },
    keys: () => new Set(pending.values()),
    waitForIdle(timeoutMs, matches = () => true) {
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new RangeError('Work drain timeout must be finite and nonnegative');
      }
      const idle = () => ![...pending.values()].some(matches);
      if (idle()) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const finish = (confirmed: boolean) => {
          clearTimeout(timer);
          waiters.delete(notify);
          resolve(confirmed);
        };
        const notify = () => {
          if (idle()) finish(true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(notify);
      });
    },
  };
}
