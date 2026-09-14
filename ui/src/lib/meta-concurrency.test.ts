import { describe, it, expect } from 'vitest';
import { metaConcurrency } from './meta-concurrency.js';
import type { MetaPoolsStatus, MetaPoolStat } from './types.js';

function pool(overrides: Partial<MetaPoolStat> = {}): MetaPoolStat {
  return {
    size: 1,
    suggestedSize: 1,
    live: 1,
    idle: 1,
    busy: 0,
    ready: true,
    served: 0,
    sessions: [],
    ...overrides,
  };
}

function status(overrides: Partial<MetaPoolsStatus> = {}): MetaPoolsStatus {
  return {
    enabled: true,
    pool: pool({ size: 5, live: 5, idle: 5 }),
    ...overrides,
  };
}

describe('metaConcurrency', () => {
  it('is 1 when the status is missing', () => {
    expect(metaConcurrency(null)).toBe(1);
    expect(metaConcurrency(undefined)).toBe(1);
  });

  it('is 1 when the warm pool is disabled', () => {
    expect(metaConcurrency(status({ enabled: false }))).toBe(1);
  });

  it('is 1 when the status carries no pool', () => {
    expect(metaConcurrency({ enabled: true })).toBe(1);
  });

  it('reserves one live session and fans out across the rest under the cap', () => {
    // 3 booted → reserve 1 for other IDE work, review across the other 2.
    expect(metaConcurrency(status({ pool: pool({ size: 3, live: 3, idle: 3 }) }))).toBe(2);
  });

  it('uses the single warm session and queues the rest when only one exists', () => {
    expect(metaConcurrency(status({ pool: pool({ size: 1, live: 1, idle: 1 }) }))).toBe(1);
  });

  it('reserves the one spare session when exactly two are booted', () => {
    expect(metaConcurrency(status({ pool: pool({ size: 2, live: 2, idle: 2 }) }))).toBe(1);
  });

  it('caps the fan-out to reserve browser connection headroom for the UI', () => {
    expect(metaConcurrency(status())).toBe(4);
    expect(metaConcurrency(status({ pool: pool({ size: 12, live: 12, idle: 12 }) }))).toBe(4);
  });

  it('never returns less than 1 even for a zero-sized pool', () => {
    expect(metaConcurrency(status({ pool: pool({ size: 0, live: 0, idle: 0 }) }))).toBe(1);
  });

  it('reserves one session against live capacity, not the momentary idle count', () => {
    const s = status({
      pool: pool({
        size: 7,
        live: 4,
        idle: 2,
        busy: 1,
        sessions: [],
        waitingForCapacity: true,
      }),
    });
    // 4 booted → review fans out across 3, reserving one for other IDE work.
    expect(metaConcurrency(s)).toBe(3);
  });
});