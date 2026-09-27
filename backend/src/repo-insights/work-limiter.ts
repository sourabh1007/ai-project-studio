/** FIFO admission shared by dashboard requests; cancelled work never starts. */
export function createWorkLimiter(limit: number) {
  let active = 0;
  const queue = new Set<() => void>();

  return async function run<T>(
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        queue.delete(start);
        signal?.removeEventListener('abort', cancel);
        active += 1;
        resolve();
      };
      const cancel = () => {
        queue.delete(start);
        reject(signal!.reason);
      };
      if (active < limit) {
        start();
      } else {
        queue.add(start);
        signal?.addEventListener('abort', cancel, { once: true });
      }
    });
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      active -= 1;
      queue.values().next().value?.();
    }
  };
}
