import { describe, it, expect } from 'vitest';
import {
  AUTH_WARMER_NAMESPACE,
  authWarmerConfigSchema,
  authWarmerDefaults,
} from './config.js';

describe('auth-warmer config', () => {
  it('exposes a stable namespace', () => {
    expect(AUTH_WARMER_NAMESPACE).toBe('authWarmer');
  });

  it('accepts the defaults', () => {
    expect(authWarmerConfigSchema.parse(authWarmerDefaults)).toEqual(
      authWarmerDefaults,
    );
    expect(authWarmerDefaults.enabled).toBe(true);
    expect(authWarmerDefaults.intervalMs).toBeGreaterThan(0);
  });

  it('rejects a non-positive interval', () => {
    expect(() =>
      authWarmerConfigSchema.parse({ enabled: true, intervalMs: 0 }),
    ).toThrow();
  });

  it('rejects a non-integer interval', () => {
    expect(() =>
      authWarmerConfigSchema.parse({ enabled: true, intervalMs: 1.5 }),
    ).toThrow();
  });
});
