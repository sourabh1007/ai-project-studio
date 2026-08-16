import { describe, it, expect } from 'vitest';
import { usageConfigSchema, usageDefaults, USAGE_NAMESPACE } from './config.js';

describe('usage config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(USAGE_NAMESPACE).toBe('usage');
    expect(usageDefaults.livePollIntervalMs).toBe(1500);
    expect(() => usageConfigSchema.parse(usageDefaults)).not.toThrow();
  });

  it('rejects a non-positive poll interval', () => {
    expect(() => usageConfigSchema.parse({ livePollIntervalMs: 0 })).toThrow();
  });
});
