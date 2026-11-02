import { join } from 'node:path';
import { z } from 'zod';
import { defaultWorkspaceDataDir } from '../workspace/workspace-paths.js';

export const LOGGING_NAMESPACE = 'logging';
export const MIN_LOG_RECORD_BYTES = 256;
export const MIN_LOG_FILE_BYTES = 1024;
const SAFE_FILE_PREFIX =
  /^(?!\.{1,2}$)(?!.*[\\/])(?=.*\S$)[^<>:"|?*\u0000-\u001f]+$/u;

export interface DailyLogPathStrategy {
  directory: string;
  resolve(date: Date, rotation: number): string;
  isManagedFile(name: string): boolean;
}

const logLevelSchema = z.enum(['none', 'error', 'warn', 'info', 'debug']);
const directorySchema = z.string().min(1).describe('Directory that daily log files are written to.');
const filePrefixSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_FILE_PREFIX)
  .describe('Safe file-name prefix appended ahead of the daily date stamp.');
const toFileSchema = z.boolean().describe('When false, only the console sink is active.');
const maxFileBytesSchema = z
  .number()
  .int()
  .min(MIN_LOG_FILE_BYTES)
  .describe('Maximum UTF-8 bytes allowed in one managed log file before rotation.');
const retainedFileCountSchema = z
  .number()
  .int()
  .positive()
  .describe('Maximum number of managed log files retained in the log directory.');
const maxRecordBytesSchema = z
  .number()
  .int()
  .min(MIN_LOG_RECORD_BYTES)
  .describe(
    'Maximum UTF-8 bytes a single emitted JSONL record may consume after truncation or omission.',
  );

const asyncWriterSchema = z
  .boolean()
  .describe('When true, file logging goes through a bounded off-thread writer. Only the degraded synchronous fallback (used after the writer failed and its exit was confirmed) can touch the file on the API thread.');
const queueMaxRecordsSchema = z
  .number()
  .int()
  .positive()
  .describe('Maximum log records buffered for the file writer; overflow is counted and reported, never silent.');
const queueMaxBytesSchema = z
  .number()
  .int()
  .min(MIN_LOG_RECORD_BYTES)
  .describe('Maximum UTF-8 bytes buffered for the file writer.');
const flushIntervalMsSchema = z
  .number()
  .int()
  .positive()
  .describe('Delay before buffered records are sent to the file writer.');
const maxBatchRecordsSchema = z
  .number()
  .int()
  .positive()
  .describe('Maximum records sent to the file writer in one batch.');
const writerAckTimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .describe('How long a batch may stay unacknowledged before the file writer is treated as stalled.');
const maxWriterRestartsSchema = z
  .number()
  .int()
  .nonnegative()
  .describe('Writer restarts attempted before logging degrades to the synchronous fallback.');

export const loggingConfigFields = {
  level: logLevelSchema.describe('Minimum level written to the console and log file.'),
  directory: directorySchema,
  filePrefix: filePrefixSchema,
  toFile: toFileSchema,
  maxFileBytes: maxFileBytesSchema,
  retainedFileCount: retainedFileCountSchema,
  maxRecordBytes: maxRecordBytesSchema,
  asyncWriter: asyncWriterSchema,
  queueMaxRecords: queueMaxRecordsSchema,
  queueMaxBytes: queueMaxBytesSchema,
  flushIntervalMs: flushIntervalMsSchema,
  maxBatchRecords: maxBatchRecordsSchema,
  writerAckTimeoutMs: writerAckTimeoutMsSchema,
  maxWriterRestarts: maxWriterRestartsSchema,
};

const loggingConfigObjectSchema = z.object(loggingConfigFields);

export const loggingConfigSchema = loggingConfigObjectSchema
  .refine((value) => value.maxFileBytes >= value.maxRecordBytes, {
    message: 'maxFileBytes must be at least maxRecordBytes',
    path: ['maxFileBytes'],
  })
  .refine((value) => value.queueMaxBytes >= value.maxRecordBytes, {
    message: 'queueMaxBytes must be at least maxRecordBytes',
    path: ['queueMaxBytes'],
  });

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

export interface LoggingFileRetentionConfig {
  maxFileBytes: number;
  retainedFileCount: number;
  maxRecordBytes: number;
}

export const loggingDefaults: LoggingConfig = {
  level: 'info',
  directory: join(defaultWorkspaceDataDir(), 'logs'),
  filePrefix: 'app',
  toFile: true,
  maxFileBytes: 10 * 1024 * 1024,
  retainedFileCount: 14,
  maxRecordBytes: 64 * 1024,
  asyncWriter: true,
  queueMaxRecords: 4096,
  queueMaxBytes: 8 * 1024 * 1024,
  flushIntervalMs: 50,
  maxBatchRecords: 256,
  writerAckTimeoutMs: 5_000,
  maxWriterRestarts: 3,
};

const loggingRetentionSchema = z
  .object({
    maxFileBytes: maxFileBytesSchema,
    retainedFileCount: retainedFileCountSchema,
    maxRecordBytes: maxRecordBytesSchema,
  })
  .refine((value) => value.maxFileBytes >= value.maxRecordBytes, {
    message: 'maxFileBytes must be at least maxRecordBytes',
    path: ['maxFileBytes'],
  });

export function resolveLoggingConfig(
  overrides: Partial<LoggingConfig>,
): LoggingConfig {
  return loggingConfigSchema.parse({
    level: overrides.level ?? loggingDefaults.level,
    directory: overrides.directory ?? loggingDefaults.directory,
    filePrefix: overrides.filePrefix ?? loggingDefaults.filePrefix,
    toFile: overrides.toFile ?? loggingDefaults.toFile,
    maxFileBytes: overrides.maxFileBytes ?? loggingDefaults.maxFileBytes,
    retainedFileCount:
      overrides.retainedFileCount ?? loggingDefaults.retainedFileCount,
    maxRecordBytes: overrides.maxRecordBytes ?? loggingDefaults.maxRecordBytes,
    asyncWriter: overrides.asyncWriter ?? loggingDefaults.asyncWriter,
    queueMaxRecords: overrides.queueMaxRecords ?? loggingDefaults.queueMaxRecords,
    queueMaxBytes: overrides.queueMaxBytes ?? loggingDefaults.queueMaxBytes,
    flushIntervalMs: overrides.flushIntervalMs ?? loggingDefaults.flushIntervalMs,
    maxBatchRecords: overrides.maxBatchRecords ?? loggingDefaults.maxBatchRecords,
    writerAckTimeoutMs: overrides.writerAckTimeoutMs ?? loggingDefaults.writerAckTimeoutMs,
    maxWriterRestarts: overrides.maxWriterRestarts ?? loggingDefaults.maxWriterRestarts,
  });
}

export function resolveLoggingFileRetentionConfig(
  overrides: Partial<LoggingFileRetentionConfig>,
): LoggingFileRetentionConfig {
  const merged: LoggingFileRetentionConfig = {
    maxFileBytes: loggingDefaults.maxFileBytes,
    retainedFileCount: loggingDefaults.retainedFileCount,
    maxRecordBytes: loggingDefaults.maxRecordBytes,
  };
  for (const [key, value] of Object.entries(overrides) as Array<
    [keyof LoggingFileRetentionConfig, number | undefined]
  >) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return loggingRetentionSchema.parse(merged);
}

/** Deterministic daily log file name, e.g. `app-2026-08-03.log`. */
export function dailyLogFileName(prefix: string, date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return `${prefix}-${iso}.log`;
}

/** Deterministic rotated daily log file name, e.g. `app-2026-08-03.1.log`. */
export function rotatedDailyLogFileName(
  prefix: string,
  date: Date,
  rotation: number,
): string {
  if (rotation <= 0) {
    return dailyLogFileName(prefix, date);
  }
  const iso = date.toISOString().slice(0, 10);
  return `${prefix}-${iso}.${rotation}.log`;
}

function escapeForRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createDailyLogPathStrategy(
  directory: string,
  prefix: string,
): DailyLogPathStrategy {
  const managedPattern = new RegExp(
    `^${escapeForRegExp(prefix)}-\\d{4}-\\d{2}-\\d{2}(?:\\.\\d+)?\\.log$`,
    'u',
  );
  return {
    directory,
    resolve: (date, rotation) =>
      join(directory, rotatedDailyLogFileName(prefix, date, rotation)),
    isManagedFile: (name) => managedPattern.test(name),
  };
}
