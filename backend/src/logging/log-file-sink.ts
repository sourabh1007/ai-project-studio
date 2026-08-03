import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogRecord, LogSink } from '../kernel/logger.js';

export interface FileLogSinkDeps {
  /** Absolute path of the log file to append to. */
  filePath: string;
  now?: () => Date;
  /** Injectable append + mkdir for testing; default to node:fs. */
  append?: (filePath: string, line: string) => void;
  ensureDir?: (dir: string) => void;
}

/** Serializes a record to a single structured JSON log line. */
export function formatLogLine(record: LogRecord, now: Date): string {
  const entry: Record<string, unknown> = {
    ts: now.toISOString(),
    level: record.level,
    message: record.message,
  };
  if (record.data !== undefined) {
    entry.data = record.data;
  }
  return `${JSON.stringify(entry)}\n`;
}

/**
 * A {@link LogSink} that appends structured JSON lines to a daily log file.
 * The parent directory is created lazily on first write so an unwritable path
 * never crashes startup — write failures are swallowed (logging must never
 * take the app down), leaving the console sink as the source of truth.
 */
export function createFileLogSink(deps: FileLogSinkDeps): LogSink {
  const now = deps.now ?? (() => new Date());
  const append = deps.append ?? appendFileSync;
  const ensureDir =
    deps.ensureDir ?? ((dir) => mkdirSync(dir, { recursive: true }));
  let dirReady = false;

  return (record) => {
    try {
      if (!dirReady) {
        ensureDir(dirname(deps.filePath));
        dirReady = true;
      }
      append(deps.filePath, formatLogLine(record, now()));
    } catch {
      // Never let logging failures propagate.
    }
  };
}

/** Combines several sinks so one record fans out to all of them. */
export function combineSinks(...sinks: LogSink[]): LogSink {
  return (record) => {
    for (const sink of sinks) {
      sink(record);
    }
  };
}
