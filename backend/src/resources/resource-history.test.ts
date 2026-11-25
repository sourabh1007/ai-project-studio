import { describe, expect, it, vi } from 'vitest';
import { createResourceHistory } from './resource-history.js';
import { resourcesDefaults } from './config.js';
import type { ResourceHistory, ResourceHistoryStore, ResourcesSnapshot } from './resources-contract.js';

function snapshot(overrides: { host?: Record<string, unknown>; app?: Record<string, unknown> } = {}): ResourcesSnapshot {
  return {
    host: { measuredAt: 100, staleAfterMs: 1000, cpuPercent: 10, freeMemoryBytes: 200, eventLoopDelayMs: 3, ...overrides.host },
    app: { status: 'ready', cpuPercent: 2, memoryBytes: 50, ...overrides.app },
    storage: { completedAt: 100, categories: [
      { id: 'app', bytes: 42, paths: [{ path: 'b', status: 'ready' }, { path: 'a', status: 'excluded' }] },
      { id: 'logs', bytes: 20, paths: [{ path: 'logs', status: 'partial' }] },
      { id: 'cache', bytes: 0, paths: [] },
    ] },
  } as unknown as ResourcesSnapshot;
}

describe('bounded resource history', () => {
  it('records measured populations, deduplicates reads at the same instant, clones and expires points', () => {
    let now = 100;
    const history = createResourceHistory({ ...resourcesDefaults, historyMaxPoints: 2, historyMaxAgeMs: 1000 }, () => now);
    history.sample(snapshot());
    history.sample(snapshot({ host: { measuredAt: null }, app: { status: 'partial' } }));
    expect(history.snapshot().samples).toHaveLength(1);
    expect(history.snapshot().samples[0]).toMatchObject({ hostCpu: null, appCpu: null, freeMemory: null, eventLoopDelay: null, appMemory: null });
    now = 101; history.sample(snapshot());
    now = 102; history.sample(snapshot());
    expect(history.snapshot().samples.map((entry) => entry.at)).toEqual([101, 102]);
    const copy = history.snapshot();
    copy.samples[0].hostCpu = 999;
    expect(history.snapshot().samples[0].hostCpu).toBe(10);
    now = 2000; history.sample(snapshot());
    expect(history.snapshot().samples).toEqual([{ at: 2000, hostCpu: null, freeMemory: null, eventLoopDelay: null, appCpu: 2, appMemory: 50 }]);
    now = 50;
    expect(history.snapshot().samples).toEqual([]);
  });

  it('rejects future host measurements, preserves storage scope and unknown bytes, and caps scans', () => {
    let now = 100;
    const history = createResourceHistory({ ...resourcesDefaults, storageHistoryMaxScans: 1 }, () => now);
    history.sample(snapshot({ host: { measuredAt: 101 } }));
    expect(history.snapshot().samples[0].hostCpu).toBeNull();
    history.storage(snapshot());
    history.storage(snapshot());
    expect(history.snapshot().storage).toHaveLength(3);
    expect(history.snapshot().storage).toContainEqual({ at: 100, category: 'app', scope: '["a","b"]', bytes: 42 });
    expect(history.snapshot().storage.filter((entry) => entry.category !== 'app').every((entry) => entry.bytes === null)).toBe(true);
    const copy = history.snapshot(); copy.storage[0].bytes = 999;
    expect(history.snapshot().storage[0].bytes).toBe(42);
    now = 101;
    const next = snapshot(); next.storage.completedAt = 101; history.storage(next);
    expect(history.snapshot().storage).toHaveLength(5);
  });

  it('restores retained samples, contains corrupt-storage failures and never fails live monitoring on save errors', () => {
    const saved: ResourceHistory = { startedAt: 1, maxGapMs: 1, error: 'old', samples: [], storage: [] };
    const store: ResourceHistoryStore = { load: vi.fn(() => saved), save: vi.fn() };
    const history = createResourceHistory(resourcesDefaults, () => 100, store);
    expect(history.snapshot()).toMatchObject({ startedAt: 1, error: null, maxGapMs: 30000 });
    history.sample(snapshot());
    expect(store.save).toHaveBeenCalledOnce();
    vi.mocked(store.save).mockImplementation(() => { throw new Error('disk busy'); });
    history.sample(snapshot());
    expect(history.snapshot().error).toContain('live samples remain');
    vi.mocked(store.load).mockImplementation(() => { throw new Error('corrupt'); });
    expect(createResourceHistory(resourcesDefaults, () => 100, store).snapshot().error).toContain('restored');
    vi.mocked(store.load).mockReturnValue(null);
    expect(createResourceHistory(resourcesDefaults, () => 100, store).snapshot().startedAt).toBe(100);
  });
});
