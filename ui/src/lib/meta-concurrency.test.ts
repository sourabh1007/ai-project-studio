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

  it('uses the pool idle capacity', () => {
    expect(metaConcurrency(status())).toBe(5);
  });

  it('never returns less than 1 even for a zero-sized pool', () => {
    expect(metaConcurrency(status({ pool: pool({ size: 0, live: 0, idle: 0 }) }))).toBe(1);
  });

  it('does not cold-spawn configured capacity that is still warming or blocked', () => {
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
    expect(metaConcurrency(s)).toBe(2);
  });
});