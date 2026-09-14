import { describe, it, expect } from 'vitest';
import {
  planUsageConfigSchema,
  planUsageDefaults,
  PLAN_USAGE_NAMESPACE,
} from './config.js';

describe('plan-usage config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(PLAN_USAGE_NAMESPACE).toBe('planUsage');
    expect(planUsageDefaults.refreshMinutes).toBe(5);
    expect(planUsageDefaults.failureThreshold).toBe(3);
    expect(() => planUsageConfigSchema.parse(planUsageDefaults)).not.toThrow();
  });

  it('rejects a refresh interval below one minute', () => {
    expect(() =>
      planUsageConfigSchema.parse({ refreshMinutes: 0, failureThreshold: 3 }),
    ).toThrow();
  });

  it('rejects a non-integer refresh interval', () => {
    expect(() =>
      planUsageConfigSchema.parse({ refreshMinutes: 2.5, failureThreshold: 3 }),
    ).toThrow();
  });

  it('rejects a failure threshold below one', () => {
    expect(() =>
      planUsageConfigSchema.parse({ refreshMinutes: 5, failureThreshold: 0 }),
    ).toThrow();
  });

  it('rejects a non-integer failure threshold', () => {
    expect(() =>
      planUsageConfigSchema.parse({ refreshMinutes: 5, failureThreshold: 1.5 }),
    ).toThrow();
  });
});
