import { join } from 'node:path';
import { z } from 'zod';
import { defaultWorkspaceDataDir } from '../workspace/workspace-paths.js';

export const LOGGING_NAMESPACE = 'logging';

export const loggingConfigSchema = z.object({
  /** Minimum level written to the console and log file. */
  level: z.enum(['none', 'error', 'warn', 'info', 'debug']),
  /** Directory that daily log files are written to. */
  directory: z.string().min(1),
  /** File-name prefix; the current date is appended per day. */
  filePrefix: z.string().min(1),
  /** When false, only the console sink is active (no file is written). */
  toFile: z.boolean(),
});

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

export const loggingDefaults: LoggingConfig = {
  level: 'info',
  directory: join(defaultWorkspaceDataDir(), 'logs'),
  filePrefix: 'app',
  toFile: true,
};

/** Deterministic daily log file name, e.g. `app-2026-08-03.log`. */
export function dailyLogFileName(prefix: string, date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return `${prefix}-${iso}.log`;
}
