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

export function createLogger(level: LogLevel, sink: LogSink): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (recordLevel: Exclude<LogLevel, 'none'>, message: string, data?: unknown): void => {
    if (LEVEL_ORDER[recordLevel] <= threshold) {
      sink({ level: recordLevel, message, data });
    }
  };

  return {
    error: (message, data) => emit('error', message, data),
    warn: (message, data) => emit('warn', message, data),
    info: (message, data) => emit('info', message, data),
    debug: (message, data) => emit('debug', message, data),
  };
}
