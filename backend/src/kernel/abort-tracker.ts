export interface AbortTracker {
  /** Root signal aborted when the process is shutting down. */
  readonly signal: AbortSignal;
  /**
   * Runs one owned task under the root shutdown signal plus an optional
   * request-local signal, and releases all listeners only once the task settles.
   */
  own<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  /** Requests shutdown for every linked operation. */
  abort(): void;
  /** Waits for all tracked operations to settle, or false on timeout. */
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

function notifyAbort(controller: AbortController): void {
  if (!controller.signal.aborted) {
    controller.abort();
  }
}

export function createAbortTracker(): AbortTracker {
  const root = new AbortController();
  const tracked = new Set<Promise<unknown>>();
  const idleWaiters = new Set<(idle: boolean) => void>();

  const notifyIdleIfNeeded = (): void => {
    if (tracked.size !== 0) {
      return;
    }
    for (const waiter of idleWaiters) {
      waiter(true);
    }
    idleWaiters.clear();
  };

  return {
    get signal() {
      return root.signal;
    },
    own<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      let linked = root.signal;
      let cleanupSignal = () => undefined;
      if (signal) {
        if (root.signal.aborted || signal.aborted) {
          const controller = new AbortController();
          notifyAbort(controller);
          linked = controller.signal;
        } else {
          const controller = new AbortController();
          const abort = () => {
            notifyAbort(controller);
          };
          root.signal.addEventListener('abort', abort, { once: true });
          signal.addEventListener('abort', abort, { once: true });
          cleanupSignal = () => {
            root.signal.removeEventListener('abort', abort);
            signal.removeEventListener('abort', abort);
          };
          linked = controller.signal;
        }
      }

      let owned!: Promise<T>;
      owned = Promise.resolve()
        .then(() => run(linked))
        .then(
          (value) => {
            cleanupSignal();
            tracked.delete(owned);
            notifyIdleIfNeeded();
            return value;
          },
          (error) => {
            cleanupSignal();
            tracked.delete(owned);
            notifyIdleIfNeeded();
            throw error;
          },
        );
      tracked.add(owned);
      return owned;
    },
    abort() {
      notifyAbort(root);
    },
    waitForIdle(timeoutMs) {
      if (tracked.size === 0) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let settled = false;
        const done = (idle: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          idleWaiters.delete(done);
          resolve(idle);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
        idleWaiters.add(done);
      });
    },
  };
}
