import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_NAMESPACE,
  lifecycleConfigSchema,
  lifecycleDefaults,
} from './config.js';

describe('lifecycle config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(LIFECYCLE_NAMESPACE).toBe('lifecycle');
    expect(lifecycleDefaults.stoppedCaptureRecoveryPageSize).toBe(8);
    expect(lifecycleDefaults.stoppedCaptureRecoveryIntervalMs).toBe(1500);
    expect(() => lifecycleConfigSchema.parse(lifecycleDefaults)).not.toThrow();
  });

  it.each([
    { stoppedCaptureRecoveryPageSize: 0 },
    { stoppedCaptureRecoveryPageSize: 1001 },
    { stoppedCaptureRecoveryPageSize: 1.5 },
  ])('rejects invalid recovery page sizes %j', (override) => {
    expect(() => lifecycleConfigSchema.parse({ ...lifecycleDefaults, ...override })).toThrow();
  });

  it.each([
    { stoppedCaptureRecoveryIntervalMs: 0 },
    { stoppedCaptureRecoveryIntervalMs: 2_147_483_648 },
    { stoppedCaptureRecoveryIntervalMs: 1.5 },
  ])('rejects invalid recovery intervals %j', (override) => {
    expect(() => lifecycleConfigSchema.parse({ ...lifecycleDefaults, ...override })).toThrow();
  });
});
