import type { FileLogSinkFailure } from './log-file-sink.js';
import type { LogWriterRequest, LogWriterResponse } from './log-writer-core.js';
import type { LogBatch, LogWriterPort } from './queued-log-sink.js';

/** The slice of `worker_threads.Worker` the port needs. */
export interface LogWorkerLike {
  postMessage(message: LogWriterRequest): void;
  on(event: 'message', listener: (message: LogWriterResponse) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface LogWriterPortOptions {
  /** How long a polite close may take before the worker is terminated. */
  closeGraceMs: number;
  onFailure?: (failure: FileLogSinkFailure) => void;
}

/** Maps a native log-writer worker onto the {@link LogWriterPort} contract. */
export function createLogWriterPort(worker: LogWorkerLike, options: LogWriterPortOptions): LogWriterPort {
  let ackHandler: (ack: { id: number; failed?: boolean }) => void = () => {};
  let downHandler: (reason: string) => void = () => {};
  let exited = false;
  let closeRequested = false;
  let closing: Promise<boolean> | null = null;
  const exitWaiters = new Set<() => void>();

  worker.on('message', (message) => {
    if (message.type === 'ack') ackHandler({ id: message.id, failed: message.failed });
    else if (message.type === 'failure') {
      try {
        options.onFailure?.(message.failure);
      } catch {
        // Failure observers must not break the writer channel.
      }
    }
  });
  worker.on('error', (error) => {
    if (!closeRequested) downHandler(`error:${error.name}`);
  });
  worker.on('exit', (code) => {
    exited = true;
    for (const waiter of [...exitWaiters]) waiter();
    if (!closeRequested) downHandler(`exit:${code}`);
  });

  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise<boolean>((resolve) => {
    if (exited) {
      resolve(true);
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      exitWaiters.delete(done);
      resolve(exited);
    };
    const timer = setTimeout(done, timeoutMs);
    exitWaiters.add(done);
  });

  return {
    post(batch: LogBatch): void {
      worker.postMessage({ type: 'batch', id: batch.id, entries: batch.entries });
    },
    onAck(handler) { ackHandler = handler; },
    onDown(handler) { downHandler = handler; },
    close(): Promise<boolean> {
      closeRequested = true;
      closing ??= (async () => {
        if (exited) return true;
        try {
          worker.postMessage({ type: 'close' });
        } catch {
          // The worker is already unusable; terminate below.
        }
        if (await waitForExit(options.closeGraceMs)) return true;
        try {
          await worker.terminate();
        } catch {
          return false;
        }
        return waitForExit(options.closeGraceMs);
      })().then((confirmed) => {
        // An unconfirmed exit may be retried; a confirmed one is final.
        if (!confirmed) closing = null;
        return confirmed;
      });
      return closing;
    },
  };
}
