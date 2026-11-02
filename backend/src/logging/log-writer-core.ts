import type { FileLogSinkFailure } from './log-file-sink.js';
import type { LogBatchEntry } from './queued-log-sink.js';

export type LogWriterRequest =
  | { type: 'batch'; id: number; entries: LogBatchEntry[] }
  | { type: 'close' };

export type LogWriterResponse =
  | { type: 'ack'; id: number; failed: boolean }
  | { type: 'failure'; failure: FileLogSinkFailure }
  | { type: 'closed' };

export interface LogWriterCoreDeps {
  /** Returns false when the line was not durably appended (failure reports are de-duplicated, so this is the proof). */
  writeLine(line: string, at: Date): boolean | void;
  reply(response: LogWriterResponse): void;
  /** Called once the writer has been asked to close and everything is written. */
  stop(): void;
}

/** Worker-side message handling, kept free of `worker_threads` so it is unit tested. */
export function createLogWriterCore(deps: LogWriterCoreDeps) {
  let batchFailures = 0;
  return {
    /** Pass as the file writer's failure hook. */
    onFailure(failure: FileLogSinkFailure): void {
      deps.reply({ type: 'failure', failure });
    },
    handle(request: LogWriterRequest): void {
      if (request.type === 'close') {
        deps.reply({ type: 'closed' });
        deps.stop();
        return;
      }
      batchFailures = 0;
      for (const entry of request.entries) {
        if (deps.writeLine(entry.line, new Date(entry.at)) === false) batchFailures += 1;
      }
      deps.reply({ type: 'ack', id: request.id, failed: batchFailures > 0 });
    },
  };
}
