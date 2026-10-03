import { describe, it, expect } from 'vitest';
import { HEALTH_NAMESPACE, healthConfigSchema, healthDefaults } from './config.js';

describe('health config', () => {
  it('exposes a stable namespace', () => {
    expect(HEALTH_NAMESPACE).toBe('health');
  });

  it('accepts the defaults', () => {
    expect(healthConfigSchema.parse(healthDefaults)).toEqual(healthDefaults);
  });

  it('rejects a non-positive timeout', () => {
    expect(() => healthConfigSchema.parse({ probeTimeoutMs: 0 })).toThrow();
  });
});
