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
    expect(() => planUsageConfigSchema.parse(planUsageDefaults)).not.toThrow();
  });

  it('rejects a refresh interval below one minute', () => {
    expect(() =>
      planUsageConfigSchema.parse({ refreshMinutes: 0 }),
    ).toThrow();
  });

  it('rejects a non-integer refresh interval', () => {
    expect(() =>
      planUsageConfigSchema.parse({ refreshMinutes: 2.5 }),
    ).toThrow();
  });
});
