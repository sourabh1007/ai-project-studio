import type { BackgroundWorkConfig } from './background-work-config.js';

export interface BackgroundWorker<T> {
  result: Promise<T>;
  /** Resolves only after the native worker has actually stopped. */
  terminate(): Promise<void>;
}

export interface BackgroundWorkOptions {
  signal?: AbortSignal;
  onState?: (state: 'queued' | 'running') => void;
  onProgress?: (message: string) => void;
}

/** CPU work must live in a worker, never in an HTTP handler's event loop. */
export function createBackgroundWorkRunner<Input, Output>(deps: {
  config: BackgroundWorkConfig;
  spawn(input: Input, progress: (message: string) => void): BackgroundWorker<Output>;
}) {
  type Job = { start(): void; stop(error: Error): void; done: Promise<void> };
  const queued = new Set<Job>();
  const active = new Set<Job>();
  let closed = false;
  const pump = () => {
    while (!closed && active.size < deps.config.maxWorkers && queued.size > 0) {
      const job = queued.values().next().value!;
      queued.delete(job);
      job.start();
    }
  };
  const cancelAll = (error: Error) => {
    for (const job of [...queued, ...active]) job.stop(error);
  };

  return {
    run(input: Input, options: BackgroundWorkOptions = {}): Promise<Output> {
      if (closed) return Promise.reject(new Error('Background analysis is stopped. Restart the app before retrying.'));
      if (options.signal?.aborted) return Promise.reject(new Error('Background analysis cancelled.'));
      if (active.size >= deps.config.maxWorkers && queued.size >= deps.config.maxQueued) {
        return Promise.reject(new Error('Background analysis queue is full. Wait for a running analysis to finish, then retry.'));
      }
      return new Promise<Output>((resolve, reject) => {
        let started = false;
        let stopped = false;
        let rejectStop!: (error: Error) => void;
        let finish!: () => void;
        const done = new Promise<void>((r) => { finish = r; });
        const stopSignal = new Promise<never>((_resolve, r) => { rejectStop = r; });
        // Queued cancellation has no worker race attached yet.
        void stopSignal.catch(() => {});
        const abort = () => job.stop(new Error('Background analysis cancelled.'));
        const timer = setTimeout(() => job.stop(new Error(
          `Background analysis exceeded ${deps.config.timeoutMs}ms and was stopped. Retry this analysis when ready.`,
        )), deps.config.timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        };
        const job: Job = {
          done,
          stop(error) {
            if (stopped) return;
            stopped = true;
            rejectStop(error);
            if (!started) {
              queued.delete(job);
              cleanup();
              reject(error);
              finish();
            }
          },
          start() {
            started = true;
            active.add(job);
            void (async () => {
              let worker: BackgroundWorker<Output> | undefined;
              try {
                options.onState?.('running');
                if (stopped) throw new Error('Background analysis cancelled.');
                worker = deps.spawn(input, (message) => {
                  if (!stopped) {
                    try {
                      options.onProgress?.(message);
                    } catch {
                      job.stop(new Error('Background analysis progress could not be saved.'));
                    }
                  }
                });
                let output: Output;
                try {
                  output = await Promise.race([worker.result, stopSignal]);
                } finally {
                  try {
                    await worker.terminate();
                    worker = undefined;
                  } catch {
                    closed = true;
                    cancelAll(new Error('Background worker termination could not be confirmed. Restart the app before retrying.'));
                    throw new Error('Background worker termination could not be confirmed.');
                  }
                }
                resolve(output);
              } catch (error) {
                reject(error);
              } finally {
                stopped = true;
                cleanup();
                if (!worker) active.delete(job);
                finish();
                pump();
              }
            })();
          },
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        queued.add(job);
        if (active.size >= deps.config.maxWorkers) {
          try {
            options.onState?.('queued');
          } catch {
            job.stop(new Error('Background analysis queue status could not be saved.'));
          }
        }
        pump();
      });
    },
    stats() {
      return {
        active: active.size,
        queued: queued.size,
        maxWorkers: deps.config.maxWorkers,
        maxQueued: deps.config.maxQueued,
      };
    },
    async close(): Promise<void> {
      closed = true;
      const jobs = [...queued, ...active];
      cancelAll(new Error('Background analysis cancelled during app shutdown.'));
      await Promise.all(jobs.map((job) => job.done));
      if (active.size > 0) throw new Error('Background workers did not confirm termination.');
    },
  };
}
