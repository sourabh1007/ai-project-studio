import { describe, it, expect } from 'vitest';
import {
  SELF_RECOVERY_NAMESPACE,
  selfRecoveryConfigSchema,
  selfRecoveryDefaults,
} from './config.js';

describe('self-recovery config', () => {
  it('exposes a stable namespace', () => {
    expect(SELF_RECOVERY_NAMESPACE).toBe('selfRecovery');
  });

  it('accepts the defaults', () => {
    expect(selfRecoveryConfigSchema.parse(selfRecoveryDefaults)).toEqual(
      selfRecoveryDefaults,
    );
    expect(selfRecoveryDefaults.enabled).toBe(true);
    expect(selfRecoveryDefaults.useMetaAnalysis).toBe(true);
  });

  it('rejects a non-boolean enabled flag', () => {
    expect(() =>
      selfRecoveryConfigSchema.parse({
        enabled: 'yes',
        useMetaAnalysis: true,
      }),
    ).toThrow();
  });

  it('rejects a missing useMetaAnalysis flag', () => {
    expect(() =>
      selfRecoveryConfigSchema.parse({ enabled: true }),
    ).toThrow();
  });
});
