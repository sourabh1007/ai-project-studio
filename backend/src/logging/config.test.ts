import { describe, it, expect } from 'vitest';
import {
  LOGGING_NAMESPACE,
  loggingConfigSchema,
  loggingDefaults,
  dailyLogFileName,
} from './config.js';

describe('logging/config', () => {
  it('has a stable namespace', () => {
    expect(LOGGING_NAMESPACE).toBe('logging');
  });

  it('provides valid defaults that satisfy the schema', () => {
    expect(loggingConfigSchema.parse(loggingDefaults)).toEqual(loggingDefaults);
    expect(loggingDefaults.directory.length).toBeGreaterThan(0);
  });

  it('rejects an unknown log level', () => {
    expect(() =>
      loggingConfigSchema.parse({ ...loggingDefaults, level: 'loud' }),
    ).toThrow();
  });

  it('builds a deterministic daily file name', () => {
    expect(dailyLogFileName('app', new Date('2026-08-03T12:34:56.000Z'))).toBe(
      'app-2026-08-03.log',
    );
  });
});
