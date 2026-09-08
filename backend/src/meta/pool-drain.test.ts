import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainMetaPool } from './pool-drain.js';

afterEach(() => vi.useRealTimers());

describe('removed warm pool drainage', () => {
  it('removes an already empty pool immediately without scheduling retries', () => {
    vi.useFakeTimers();
    const pool = { resize: vi.fn(), stats: () => ({ live: 0 }), close: vi.fn() };
    const onDrained = vi.fn();
    drainMetaPool({ pool, onDrained, onError: vi.fn() });
    expect(pool.resize).toHaveBeenCalledWith(0);
    expect(pool.close).toHaveBeenCalledOnce();
    expect(onDrained).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains drainage and retries after an initial retirement failure instead of orphaning the pool', async () => {
    vi.useFakeTimers();
    const failure = new Error('Native kill failed');
    let live = 2;
    const pool = {
      resize: vi.fn().mockImplementationOnce(() => { throw failure; }),
      stats: () => ({ live }), close: vi.fn(),
    };
    const onDrained = vi.fn();
    const onError = vi.fn();
    drainMetaPool({ pool, onDrained, onError });
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(700);
    expect(pool.close).not.toHaveBeenCalled();
    expect(onDrained).not.toHaveBeenCalled();
    expect(pool.resize.mock.calls).toEqual([[0], [0]]);
    live = 0;
    await vi.advanceTimersByTimeAsync(700);
    expect(onDrained).toHaveBeenCalledOnce();
    expect(pool.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports timer/close failures and keeps the pool visible until closure succeeds', async () => {
    vi.useFakeTimers();
    let live = 1;
    const pool = {
      resize: vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('retry failed'); }),
      stats: () => ({ live }),
      close: vi.fn().mockImplementationOnce(() => { throw new Error('close failed'); }),
    };
    const onDrained = vi.fn();
    const onError = vi.fn();
    drainMetaPool({ pool, onDrained, onError, retryMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledTimes(1);
    live = 0;
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onDrained).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(onDrained).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
