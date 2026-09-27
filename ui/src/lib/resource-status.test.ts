import { describe, expect, it } from 'vitest';
import { resourceStatus } from './resource-status.js';
import type { ResourceSnapshot } from './types.js';

const normal: ResourceSnapshot = {
  status: 'normal', reasons: [], measuredAt: 1_000, staleAfterMs: 30_000,
  cpuPercent: 20, freeMemoryBytes: 8 * 1024 ** 3,
  totalMemoryBytes: 16 * 1024 ** 3, eventLoopDelayMs: 20,
};

describe('resource status', () => {
  it('shows actual normal metrics, not a loading indicator', () => {
    const view = resourceStatus(normal, 'online', false, 1_001);
    expect(view.label).toBe('Resources normal');
    expect(view.detail).toContain('20%');
    expect(view.detail).toContain('8.0 / 16.0 GiB');
    expect(view.detail).toContain('20 ms');
    expect(view.detail).toContain('No resource pressure measured');
  });
  it.each(['high-cpu', 'low-memory', 'event-loop-lag'] as const)('shows measured %s', (reason) => {
    const view = resourceStatus({ ...normal, status: 'pressure', reasons: [reason] }, 'online', false, 1_000);
    expect(view.label).toBe('Resource pressure');
    expect(view.detail).toContain('Measured pressure:');
    expect(view.detail).toContain('retry failed reads');
  });
  it('shows every measured cause', () => {
    const view = resourceStatus({
      ...normal, status: 'pressure', reasons: ['high-cpu', 'low-memory', 'event-loop-lag'],
    }, 'online', false, 1_000);
    expect(view.detail).toContain('high system CPU, low free system memory, backend event-loop delay');
  });
  it('shows optional admission counts without diagnosing pressure from a queue', () => {
    const view = resourceStatus({
      ...normal, backgroundWork: { active: 1, queued: 8, maxWorkers: 1, maxQueued: 8 },
    }, 'online', false, 1_000);
    expect(view.label).toBe('Resources normal');
    expect(view.detail).toContain('1/1 active, 8/8 queued');
    expect(view.detail).toContain('Queueing alone does not indicate resource pressure');
    expect(resourceStatus({
      ...normal, backgroundWork: { active: 1, queued: 8, maxWorkers: 1, maxQueued: 8 },
    }, 'online', false, 31_000).detail).not.toContain('queued');
  });
  it('expires snapshots and rejects future timestamps', () => {
    expect(resourceStatus(normal, 'online', false, 30_999).state).toBe('normal');
    expect(resourceStatus(normal, 'online', false, 31_000).state).toBe('unknown');
    expect(resourceStatus(normal, 'online', false, 999).state).toBe('unknown');
  });
  it.each([undefined, { ...normal, status: 'unknown' as const }, { ...normal, measuredAt: null }])(
    'handles absent or unknown measurements', (snapshot) => {
      expect(resourceStatus(snapshot, 'online', false, 1_000).label).toBe('Resources unknown');
    },
  );
  it('never diagnoses resource pressure from unresponsiveness or offline state', () => {
    const pressure: ResourceSnapshot = { ...normal, status: 'pressure', reasons: ['high-cpu'] };
    expect(resourceStatus(pressure, 'online', true, 1_000).label).toBe('Backend unresponsive');
    expect(resourceStatus(pressure, 'backend-down', false, 1_000).label).toBe('Backend unresponsive');
    expect(resourceStatus(pressure, 'offline', false, 1_000).label).toBe('Resources unknown');
  });
});
