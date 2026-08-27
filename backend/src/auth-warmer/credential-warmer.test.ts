import { describe, it, expect, vi } from 'vitest';
import { createCredentialWarmer } from './credential-warmer.js';

describe('createCredentialWarmer', () => {
  it('warms once by invoking the injected refresh', async () => {
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const warmer = createCredentialWarmer({ refresh, intervalMs: 1000 });

    await warmer.warm();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected refresh to onError and never throws', async () => {
    const error = new Error('boom');
    const refresh = vi.fn<() => Promise<void>>().mockRejectedValue(error);
    const onError = vi.fn();
    const warmer = createCredentialWarmer({ refresh, intervalMs: 1000, onError });

    await expect(warmer.warm()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });

  it('swallows a rejected refresh when no onError hook is given', async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('boom'));
    const warmer = createCredentialWarmer({ refresh, intervalMs: 1000 });

    await expect(warmer.warm()).resolves.toBeUndefined();
  });

  it('warms periodically once started and stops on stop (both idempotent)', async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const warmer = createCredentialWarmer({ refresh, intervalMs: 1000 });

      warmer.start();
      warmer.start(); // no-op second call
      await vi.advanceTimersByTimeAsync(1000);
      expect(refresh).toHaveBeenCalledTimes(1);

      warmer.stop();
      warmer.stop(); // no-op second call
      await vi.advanceTimersByTimeAsync(3000);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
