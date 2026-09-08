import { describe, it, expect } from 'vitest';
import { usageConfigSchema, usageDefaults, USAGE_NAMESPACE } from './config.js';

describe('usage config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(USAGE_NAMESPACE).toBe('usage');
    expect(usageDefaults.livePollIntervalMs).toBe(1500);
    expect(() => usageConfigSchema.parse(usageDefaults)).not.toThrow();
  });

  it('rejects a non-positive poll interval', () => {
    expect(() => usageConfigSchema.parse({ ...usageDefaults, livePollIntervalMs: 0 })).toThrow();
  });

  it.each([
    { capturePageSize: 0 }, { capturePageSize: 1001 }, { capturePageSize: 1.5 },
    { finalDrainPages: 0 }, { finalDrainPages: 101 }, { finalDrainPages: 1.5 },
  ])('rejects unbounded or invalid capture work limits %j', (override) => {
    expect(() => usageConfigSchema.parse({ ...usageDefaults, ...override })).toThrow();
  });
});
