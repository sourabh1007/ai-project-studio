import { describe, expect, it, vi } from 'vitest';
import { createCapacityHistory } from './capacity-history.js';
import type { CapacityPoint, CapacityHistoryStore } from './capacity-history.js';
import type { MetaPoolsStatus } from './pooled-meta-runner.js';

describe('capacity sample history', () => {
  it('records actual shared admission and warm capacity, deduplicates timestamps and bounds history', () => {
    let now = 100;
    const store: CapacityHistoryStore = { load: () => [], save: vi.fn() };
    const history = createCapacityHistory({ now: () => now, config: { monitoringHistoryPoints: 2, monitoringHistoryMs: 1000 }, store });
    const status = { enabled: true, model: 'auto', pool: { busy: 1, idle: 2, sessions: [{ state: 'warming' }, { state: 'busy' }] },
      processAdmission: { processes: 4, queued: 3 } } as MetaPoolsStatus;
    history.sample(status, 'copilot'); history.sample(status, 'copilot');
    expect(history.snapshot().samples).toHaveLength(1);
    expect(history.snapshot().samples[0]).toMatchObject({ provider: 'copilot', busy: 1, idle: 2, warming: 1, processes: 4, queued: 3 });
    now = 101; history.sample({ enabled: false }, 'claude');
    now = 102; history.sample({ enabled: false }, 'claude');
    const copy = history.snapshot(); copy.samples[0].queued = 999;
    expect(history.snapshot().samples[0]).toMatchObject({ at: 101, model: null, busy: null, idle: null, warming: null, queued: null });
    now = 2000; expect(history.snapshot().samples).toEqual([]);
    now = 50; history.sample(status, 'copilot');
    now = 1; expect(history.snapshot().samples).toEqual([]);
  });
  it('restores durable points and keeps collection running after load/save failures', () => {
    const points: CapacityPoint[] = [{ at: 1, provider: 'p', model: null, busy: null, idle: null, warming: null, queued: null, processes: null }];
    const store: CapacityHistoryStore = { load: vi.fn(() => points), save: vi.fn() };
    const deps = { now: () => 100, config: { monitoringHistoryPoints: 2, monitoringHistoryMs: 1000 }, store };
    expect(createCapacityHistory(deps).snapshot().samples).toEqual(points);
    vi.mocked(store.load).mockImplementation(() => { throw new Error('read'); });
    const history = createCapacityHistory(deps);
    expect(history.snapshot().error).toContain('restored');
    vi.mocked(store.save).mockImplementation(() => { throw new Error('write'); });
    history.sample({ enabled: false }, 'p');
    expect(history.snapshot().error).toContain('live-only');
    vi.mocked(store.save).mockImplementation(() => {});
    history.sample({ enabled: false }, 'p');
    expect(history.snapshot().error).toBeNull();
  });
});
