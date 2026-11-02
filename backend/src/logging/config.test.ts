import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfigSchemaRegistry } from '../config/config-schema-registry.js';
import { buildConfig } from '../config/config-validator.js';
import { describeNamespaces } from '../config/config-schema-describe.js';
import {
  createDailyLogPathStrategy,
  dailyLogFileName,
  LOGGING_NAMESPACE,
  loggingConfigFields,
  loggingConfigSchema,
  loggingDefaults,
  MIN_LOG_FILE_BYTES,
  MIN_LOG_RECORD_BYTES,
  resolveLoggingConfig,
  resolveLoggingFileRetentionConfig,
  rotatedDailyLogFileName,
} from './config.js';

describe('logging/config', () => {
  it('has a stable namespace', () => {
    expect(LOGGING_NAMESPACE).toBe('logging');
  });

  it('provides valid defaults that satisfy the schema', () => {
    expect(loggingConfigSchema.parse(loggingDefaults)).toEqual(loggingDefaults);
  });

  it('merges legacy persisted settings with new defaults', () => {
    expect(
      resolveLoggingConfig({
        level: 'debug',
        directory: 'C:\\logs',
        filePrefix: 'workspace',
        toFile: false,
      }),
    ).toEqual({
      ...loggingDefaults,
      level: 'debug',
      directory: 'C:\\logs',
      filePrefix: 'workspace',
      toFile: false,
    });
  });

  it('loads stored overrides through the application registry and exposes editable fields', () => {
    const registry = createConfigSchemaRegistry();
    registry.register({
      namespace: LOGGING_NAMESPACE, schema: loggingConfigSchema, defaults: loggingDefaults,
    });
    const config = buildConfig({
      registry,
      secretLookup: () => undefined,
      sources: [{ origin: 'overrides', data: { logging: {
        level: 'debug', filePrefix: 'x',
        maxFileBytes: 1024, maxRecordBytes: 256, retainedFileCount: 1,
      } } }],
    });
    expect(config.logging).toEqual({
      ...loggingDefaults, level: 'debug', filePrefix: 'x',
      maxFileBytes: 1024, maxRecordBytes: 256, retainedFileCount: 1,
    });
    const described = describeNamespaces(registry).logging;
    expect(described.kind).toBe('object');
    expect(described.fields?.maxFileBytes).toMatchObject({ kind: 'number', min: 1024 });
    expect(described.fields?.maxRecordBytes).toMatchObject({ kind: 'number', min: 256 });
    expect(described.fields?.retainedFileCount?.kind).toBe('number');
  });

  it('allows overriding the new retention controls through full logging config resolution', () => {
    expect(
      resolveLoggingConfig({
        maxFileBytes: 2 * 1024 * 1024,
        retainedFileCount: 7,
        maxRecordBytes: 8 * 1024,
      }),
    ).toMatchObject({
      maxFileBytes: 2 * 1024 * 1024,
      retainedFileCount: 7,
      maxRecordBytes: 8 * 1024,
    });
  });

  it('describes and validates the new retention controls', () => {
    expect(loggingConfigFields.maxFileBytes.description).toMatch(/managed log file/i);
    expect(loggingConfigFields.retainedFileCount.description).toMatch(/retained/i);
    expect(loggingConfigFields.maxRecordBytes.description).toMatch(/jsonl record/i);
    expect(resolveLoggingFileRetentionConfig({})).toEqual({
      maxFileBytes: loggingDefaults.maxFileBytes,
      retainedFileCount: loggingDefaults.retainedFileCount,
      maxRecordBytes: loggingDefaults.maxRecordBytes,
    });
    expect(() => resolveLoggingFileRetentionConfig({ maxRecordBytes: MIN_LOG_RECORD_BYTES - 1 }))
      .toThrow();
    expect(() => resolveLoggingFileRetentionConfig({ maxFileBytes: MIN_LOG_FILE_BYTES - 1 }))
      .toThrow();
    expect(() => resolveLoggingFileRetentionConfig({
      maxFileBytes: loggingDefaults.maxRecordBytes - 1,
      maxRecordBytes: loggingDefaults.maxRecordBytes,
    })).toThrow(/maxFileBytes/);
  });

  it('rejects unsafe file prefixes and unknown levels', () => {
    expect(resolveLoggingConfig({ filePrefix: 'x' }).filePrefix).toBe('x');
    expect(() =>
      resolveLoggingConfig({ ...loggingDefaults, filePrefix: '..\\escape' }),
    ).toThrow();
    expect(() =>
      resolveLoggingConfig({ ...loggingDefaults, level: 'loud' as never }),
    ).toThrow();
  });

  it('builds deterministic daily file names and strategies', () => {
    const at = new Date('2026-08-03T12:34:56.000Z');
    expect(dailyLogFileName('app', at)).toBe('app-2026-08-03.log');
    expect(rotatedDailyLogFileName('app', at, 0)).toBe('app-2026-08-03.log');
    expect(rotatedDailyLogFileName('app', at, 2)).toBe('app-2026-08-03.2.log');
    const directory = join(tmpdir(), 'logging-config-fixture');
    const strategy = createDailyLogPathStrategy(directory, 'workspace');
    expect(strategy.resolve(at, 0)).toBe(join(directory, 'workspace-2026-08-03.log'));
    expect(strategy.resolve(at, 3)).toBe(join(directory, 'workspace-2026-08-03.3.log'));
    expect(strategy.isManagedFile('workspace-2026-08-03.log')).toBe(true);
    expect(strategy.isManagedFile('workspace-2026-08-03.3.log')).toBe(true);
    expect(strategy.isManagedFile('workspace-2026-08-03.txt')).toBe(false);
  });
});

describe('logging/config async writer controls', () => {
  it('defaults to a bounded async writer and validates every control', () => {
    expect(loggingDefaults).toMatchObject({
      asyncWriter: true, queueMaxRecords: 4096, flushIntervalMs: 50, maxBatchRecords: 256,
      writerAckTimeoutMs: 5_000, maxWriterRestarts: 3,
    });
    expect(resolveLoggingConfig({
      asyncWriter: false, queueMaxRecords: 1, queueMaxBytes: 1024, maxRecordBytes: 256, flushIntervalMs: 1,
      maxBatchRecords: 1, writerAckTimeoutMs: 1, maxWriterRestarts: 0,
    })).toMatchObject({ asyncWriter: false, queueMaxRecords: 1, maxWriterRestarts: 0 });
    for (const bad of [
      { queueMaxRecords: 0 }, { flushIntervalMs: 0 }, { maxBatchRecords: 0 },
      { writerAckTimeoutMs: 0 }, { maxWriterRestarts: -1 }, { queueMaxBytes: MIN_LOG_RECORD_BYTES - 1 },
    ]) {
      expect(() => resolveLoggingConfig(bad)).toThrow();
    }
    expect(() => resolveLoggingConfig({ queueMaxBytes: loggingDefaults.maxRecordBytes - 1 }))
      .toThrow(/queueMaxBytes/);
  });

  it('exposes the controls as editable described fields', () => {
    const registry = createConfigSchemaRegistry();
    registry.register({ namespace: LOGGING_NAMESPACE, schema: loggingConfigSchema, defaults: loggingDefaults });
    const fields = describeNamespaces(registry).logging.fields!;
    for (const key of ['queueMaxRecords', 'queueMaxBytes', 'flushIntervalMs', 'maxBatchRecords', 'writerAckTimeoutMs', 'maxWriterRestarts']) {
      expect(fields[key]).toMatchObject({ kind: 'number' });
    }
    expect(fields.asyncWriter.kind).toBe('boolean');
  });
});
