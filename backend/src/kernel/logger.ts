/** Leveled logger with an injectable sink. Level is configuration-driven. */

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

export interface LogRecord {
  level: Exclude<LogLevel, 'none'>;
  message: string;
  data?: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  error(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface LogSinkFailure {
  sink: string;
  errorName: string;
  /** Total failures of this sink so far; reports are thinned to powers of two. */
  failures: number;
}

export type LogSinkFailureReporter = (failure: LogSinkFailure) => void;

export function failureErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

/** Last-resort reporter: one stderr line with the error name only, never the message or data. */
export function createStderrSinkFailureReporter(
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): LogSinkFailureReporter {
  return (failure) => {
    write(`${JSON.stringify({ component: 'log-sink', kind: 'failure', ...failure })}\n`);
  };
}

/**
 * Logging must never throw into callers or starve sibling sinks. A failing sink
 * is counted and reported (first failure, then every power of two) instead of
 * being swallowed silently.
 */
export function guardSink(
  sink: LogSink,
  name: string,
  report: LogSinkFailureReporter = createStderrSinkFailureReporter(),
): LogSink {
  let failures = 0;
  return (record) => {
    try {
      sink(record);
    } catch (error) {
      failures += 1;
      if ((failures & (failures - 1)) !== 0) return;
      try {
        report({
          sink: name,
          errorName: failureErrorName(error),
          failures,
        });
      } catch {
        // The reporter is the last channel; it must not throw into the caller.
      }
    }
  };
}

export interface LoggerOptions {
  onSinkFailure?: LogSinkFailureReporter;
}

export function createLogger(level: LogLevel, sink: LogSink, options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[level];
  const guarded = guardSink(sink, 'logger', options.onSinkFailure);

  const emit = (recordLevel: Exclude<LogLevel, 'none'>, message: string, data?: unknown): void => {
    if (LEVEL_ORDER[recordLevel] <= threshold) {
      guarded({ level: recordLevel, message, data });
    }
  };

  return {
    error: (message, data) => emit('error', message, data),
    warn: (message, data) => emit('warn', message, data),
    info: (message, data) => emit('info', message, data),
    debug: (message, data) => emit('debug', message, data),
  };
}
