import { describe, expect, it, vi } from 'vitest';
import { createWorkLimiter } from './work-limiter.js';

describe('dashboard work limiter', () => {
  it('bounds active work and releases slots after success and failure', async () => {
    const run = createWorkLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        if (index === 0) throw new Error('failed');
        return index;
      }),
    ));
    expect(peak).toBe(2);
    expect(results[0].status).toBe('rejected');
    expect(results.slice(1).every((result) => result.status === 'fulfilled')).toBe(true);
  });

  it('rejects pre-cancelled work without starting it', async () => {
    const controller = new AbortController();
    controller.abort();
    const work = vi.fn();
    await expect(createWorkLimiter(1)(work, controller.signal)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });

  it('removes queued cancellation immediately without consuming a slot', async () => {
    const run = createWorkLimiter(1);
    let release!: () => void;
    const first = run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const controller = new AbortController();
    const work = vi.fn();
    const cancelled = expect(run(work, controller.signal)).rejects.toThrow();
    const last = run(async () => 'last');
    controller.abort();
    await cancelled;
    expect(work).not.toHaveBeenCalled();
    release();
    await first;
    expect(await last).toBe('last');
  });

  it('checks cancellation after acquiring a slot and passes a live signal', async () => {
    const run = createWorkLimiter(1);
    const controller = new AbortController();
    const work = vi.fn();
    const promise = run(work, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(await run(async () => 'ok', new AbortController().signal)).toBe('ok');
  });
});
