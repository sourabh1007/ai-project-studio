import { formatLogLine } from './log-file-sink.js';
import type { LoggingConfig } from './config.js';
import {
  createQueuedLogSink,
  type LogQueueEvent,
  type LogWriterPort,
  type QueuedLogSink,
} from './queued-log-sink.js';

export interface QueuedFileLoggingDeps {
  config: Pick<
    LoggingConfig,
    'queueMaxRecords' | 'queueMaxBytes' | 'flushIntervalMs' | 'maxBatchRecords' | 'writerAckTimeoutMs' | 'maxWriterRestarts' | 'maxRecordBytes'
  >;
  /** Starts the off-thread writer (native: spawnLogWriterWorker). */
  spawnWriter(): LogWriterPort;
  /** Synchronous degraded path used after the writer fails or closes. */
  fallback?: (line: string, at: Date) => void;
  onEvent?: (event: LogQueueEvent) => void;
}

/** Public factory: bounded, off-thread file logging with explicit flush/close/stats. */
export function createQueuedFileLogging(deps: QueuedFileLoggingDeps): QueuedLogSink {
  return createQueuedLogSink({
    config: deps.config,
    format: (record, at) => formatLogLine(record, at, deps.config.maxRecordBytes),
    spawnWriter: deps.spawnWriter,
    fallback: deps.fallback,
    onEvent: deps.onEvent,
  });
}
