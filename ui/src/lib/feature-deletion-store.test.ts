import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { FeatureDeletionStore } from './feature-deletion-store.js';

const feature = { id: 'feature', name: 'Development' };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('FeatureDeletionStore', () => {
  it('runs without subscribers, serializes deletion, deduplicates active requests and dismisses only finished jobs', async () => {
    const store = new FeatureDeletionStore();
    let finish!: () => void;
    const first = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const second = vi.fn().mockResolvedValue(undefined);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getSnapshot()).toEqual([]);
    expect(store.enqueue(feature, first)).toBe(true);
    expect(store.enqueue(feature, second)).toBe(true);
    expect(store.enqueue({ ...feature, id: 'second' }, second)).toBe(true);
    store.dismiss(feature.id);
    expect(store.getSnapshot().map((job) => job.status)).toEqual(['running', 'queued']);
    expect(second).not.toHaveBeenCalled();
    unsubscribe();
    const calls = listener.mock.calls.length;
    finish();
    await flush();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(store.getSnapshot().map((job) => job.status)).toEqual(['succeeded', 'succeeded']);
    expect(listener).toHaveBeenCalledTimes(calls);
    store.dismiss(feature.id);
    expect(store.getSnapshot().map((job) => job.id)).toEqual(['second']);
  });

  it('reports stopping owned work and retries only bounded conflicts', async () => {
    let time = 0;
    const store = new FeatureDeletionStore(() => time, async () => { time += 500; });
    const messages: string[] = [];
    store.subscribe(() => messages.push(store.getSnapshot()[0].message));
    const work = vi.fn().mockRejectedValueOnce(new ApiError(409, 'Still stopping')).mockResolvedValue(undefined);
    store.enqueue(feature, work);
    await flush();
    expect(messages).toContain('Waiting for active work to stop');
    expect(work).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()[0].status).toBe('succeeded');
  });

  it('uses the normal timed retry without blocking another subscriber', async () => {
    vi.useFakeTimers();
    try {
      const store = new FeatureDeletionStore();
      const work = vi.fn().mockRejectedValueOnce(new ApiError(409, 'Still stopping')).mockResolvedValue(undefined);
      store.enqueue(feature, work);
      await flush();
      expect(store.getSnapshot()[0].message).toBe('Waiting for active work to stop');
      await vi.advanceTimersByTimeAsync(500);
      expect(work).toHaveBeenCalledTimes(2);
      expect(store.getSnapshot()[0].status).toBe('succeeded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops conflict retries at the deadline and permits a later explicit retry', async () => {
    let time = 0;
    const store = new FeatureDeletionStore(() => time, async () => { time = 30_000; });
    const work = vi.fn().mockRejectedValue(new ApiError(409, 'Work has not stopped'));
    store.enqueue(feature, work);
    await flush();
    expect(work).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('Work has not stopped') });
    store.enqueue(feature, async () => {});
    await flush();
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0].status).toBe('succeeded');
  });

  it.each([new Error('Offline'), new ApiError(0, 'Connection lost'), new ApiError(500, 'Server failed'), 'Rejected'])(
    'does not automatically repeat failed or ambiguous deletion: %s', async (failure) => {
      const store = new FeatureDeletionStore();
      const work = vi.fn().mockRejectedValue(failure);
      store.enqueue(feature, work);
      store.enqueue({ id: 'next', name: 'Next' }, async () => {});
      await flush();
      expect(work).toHaveBeenCalledOnce();
      expect(store.getSnapshot()[0]).toMatchObject({ status: 'failed',
        message: expect.stringContaining('Check the feature before trying Delete feature again.') });
      expect(store.getSnapshot()[1].status).toBe('succeeded');
    },
  );

  it('bounds the queue and evicts old finished history instead of active deletions', async () => {
    const store = new FeatureDeletionStore();
    const work = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < 30; i++) {
      expect(store.enqueue({ id: String(i), name: String(i) }, work)).toBe(true);
    }
    expect(store.enqueue({ id: 'overflow', name: 'Overflow' }, work)).toBe(false);
    await flush();
    for (let i = 0; i < 30; i++) await flush();
    expect(store.getSnapshot()).toHaveLength(30);
    expect(store.enqueue({ id: 'new', name: 'New' }, work)).toBe(true);
    await flush();
    expect(store.getSnapshot()).toHaveLength(30);
    expect(store.getSnapshot().some((job) => job.id === '0')).toBe(false);
  });
});
