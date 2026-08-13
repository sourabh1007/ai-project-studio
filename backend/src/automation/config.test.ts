import { describe, it, expect } from 'vitest';
import {
  automationConfigSchema,
  automationDefaults,
  AUTOMATION_NAMESPACE,
} from './config.js';

describe('automation config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(AUTOMATION_NAMESPACE).toBe('automation');
    expect(() => automationConfigSchema.parse(automationDefaults)).not.toThrow();
  });

  it('rejects a non-positive default interval', () => {
    expect(() =>
      automationConfigSchema.parse({ ...automationDefaults, defaultIntervalMs: 0 }),
    ).toThrow();
  });

  it('rejects a non-positive min interval', () => {
    expect(() =>
      automationConfigSchema.parse({ ...automationDefaults, minIntervalMs: -1 }),
    ).toThrow();
  });

  it('rejects a non-positive concurrency', () => {
    expect(() =>
      automationConfigSchema.parse({
        ...automationDefaults,
        maxConcurrentChecks: 0,
      }),
    ).toThrow();
  });

  it('rejects a non-positive active cap', () => {
    expect(() =>
      automationConfigSchema.parse({
        ...automationDefaults,
        maxActiveAutomations: 0,
      }),
    ).toThrow();
  });

  it('rejects a non-positive run timeout', () => {
    expect(() =>
      automationConfigSchema.parse({ ...automationDefaults, runTimeoutMs: 0 }),
    ).toThrow();
  });

  it('has a floor below the default interval', () => {
    expect(automationDefaults.minIntervalMs).toBeLessThanOrEqual(
      automationDefaults.defaultIntervalMs,
    );
  });
});
