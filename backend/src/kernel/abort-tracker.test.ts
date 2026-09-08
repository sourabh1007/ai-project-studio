import { describe, it, expect, vi } from 'vitest';
import { createAbortTracker } from './abort-tracker.js';

function instrumentAbortListeners(signal: AbortSignal): {
  activeCount: () => number;
  restore: () => void;
} {
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const active = new Set<NonNullable<Parameters<AbortSignal['addEventListener']>[1]>>();

  signal.addEventListener = ((type, listener, options) => {
    if (type === 'abort' && listener) {
      active.add(listener);
    }
    return originalAdd(type, listener, options);
  }) as AbortSignal['addEventListener'];

  signal.removeEventListener = ((type, listener, options) => {
    if (type === 'abort' && listener) {
      active.delete(listener);
    }
    return originalRemove(type, listener, options);
  }) as AbortSignal['removeEventListener'];

  return {
    activeCount: () => active.size,
    restore: () => {
      signal.addEventListener = originalAdd;
      signal.removeEventListener = originalRemove;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createAbortTracker', () => {
  it('uses the root signal when no request signal is provided', async () => {
    const tracker = createAbortTracker();
    let seen: AbortSignal | undefined;

    await tracker.own(async (signal) => {
      seen = signal;
    });

    expect(seen).toBe(tracker.signal);
  });

  it('passes an already-aborted linked signal when shutdown or the request was already aborted', async () => {
    const tracker = createAbortTracker();
    tracker.abort();
    await expect(
      tracker.own(async (signal) => signal.aborted, new AbortController().signal),
    ).resolves.toBe(true);

    const tracker2 = createAbortTracker();
    const request = new AbortController();
    request.abort();
    await expect(tracker2.own(async (signal) => signal.aborted, request.signal)).resolves.toBe(
      true,
    );
  });

  it('tracks in-flight work until it settles', async () => {
    const tracker = createAbortTracker();
    let resolveWork: () => void = () => undefined;
    const work = tracker.own(
      async () =>
        new Promise<void>((resolve) => {
          resolveWork = resolve;
        }),
      new AbortController().signal,
    );
    await Promise.resolve();
    const waiting = tracker.waitForIdle(10);
    resolveWork();
    await expect(work).resolves.toBeUndefined();
    await expect(waiting).resolves.toBe(true);
  });

  it('does not report idle while other tracked work is still running', async () => {
    vi.useFakeTimers();
    try {
      const tracker = createAbortTracker();
      let resolveFirst: () => void = () => undefined;
      const request = new AbortController();
      void tracker.own(
        async () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
        request.signal,
      );
      await Promise.resolve();
      void tracker.own(async () => new Promise<void>(() => undefined), request.signal);
      const waiting = tracker.waitForIdle(1);
      resolveFirst();
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when tracked work does not settle before the timeout', async () => {
    const tracker = createAbortTracker();
    void tracker.own(async () => new Promise<void>(() => undefined), new AbortController().signal);
    await expect(tracker.waitForIdle(1)).resolves.toBe(false);
  });

  it('resolves waitForIdle immediately when nothing is tracked', async () => {
    const tracker = createAbortTracker();
    await expect(tracker.waitForIdle(1)).resolves.toBe(true);
  });

  it('aborts owned signals on shutdown', async () => {
    const tracker = createAbortTracker();
    let seen: AbortSignal | undefined;
    const owned = tracker.own(
      async (signal) => {
        seen = signal;
        return new Promise<void>(() => undefined);
      },
      new AbortController().signal,
    );
    await Promise.resolve();
    tracker.abort();
    expect(tracker.signal.aborted).toBe(true);
    expect(seen?.aborted).toBe(true);
    owned.catch(() => undefined);
  });

  it('does not emit unhandledRejection when the caller handles a failed owned promise', async () => {
    const tracker = createAbortTracker();
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    try {
      const owned = tracker.own(
        async () => Promise.reject(new Error('boom')),
        new AbortController().signal,
      );
      await expect(owned).rejects.toThrow('boom');
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('does not emit unhandledRejection when cancellation is handled by the caller', async () => {
    const tracker = createAbortTracker();
    const request = new AbortController();
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    try {
      const owned = tracker.own(
        async (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            );
          }),
        request.signal,
      );
      await Promise.resolve();
      tracker.abort();
      await expect(owned).rejects.toThrow('cancelled');
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('cleans up root abort listeners after repeated success, failure, and cancellation', async () => {
    const tracker = createAbortTracker();
    const listeners = instrumentAbortListeners(tracker.signal);
    try {
      for (let index = 0; index < 25; index += 1) {
        await tracker.own(async () => undefined, new AbortController().signal);
        await expect(
          tracker.own(async () => Promise.reject(new Error('boom')), new AbortController().signal),
        ).rejects.toThrow('boom');
        const request = new AbortController();
        const cancelled = tracker.own(
          async (signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new Error('cancelled')),
                { once: true },
              );
            }),
          request.signal,
        );
        await flush();
        request.abort();
        await expect(cancelled).rejects.toThrow('cancelled');
      }
      expect(listeners.activeCount()).toBe(0);
    } finally {
      listeners.restore();
    }
  });

  it('ignores a later idle notification after waitForIdle already timed out', async () => {
    const tracker = createAbortTracker();
    let resolveWork: () => void = () => undefined;
    const owned = tracker.own(
      async () =>
        new Promise<void>((resolve) => {
          resolveWork = resolve;
        }),
      new AbortController().signal,
    );
    await Promise.resolve();
    const waiting = tracker.waitForIdle(1);
    await expect(waiting).resolves.toBe(false);
    resolveWork();
    await expect(owned).resolves.toBeUndefined();
  });

  it('ignores a later timeout callback after waitForIdle already resolved idle', async () => {
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    try {
      const tracker = createAbortTracker();
      let resolveWork: () => void = () => undefined;
      const owned = tracker.own(
        async () =>
          new Promise<void>((resolve) => {
            resolveWork = resolve;
          }),
        new AbortController().signal,
      );
      await Promise.resolve();
      const waiting = tracker.waitForIdle(20);
      resolveWork();
      await expect(owned).resolves.toBeUndefined();
      await expect(waiting).resolves.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });
});
