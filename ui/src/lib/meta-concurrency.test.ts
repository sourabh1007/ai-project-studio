import { describe, it, expect } from 'vitest';
import { metaConcurrency, GENERAL_PURPOSE } from './meta-concurrency.js';
import type { MetaPoolsStatus, MetaPoolStat } from './types.js';

function pool(overrides: Partial<MetaPoolStat> & { purpose: string }): MetaPoolStat {
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
    pools: [pool({ purpose: GENERAL_PURPOSE, size: 5 })],
    ...overrides,
  };
}

describe('metaConcurrency', () => {
  it('is 1 when the status is missing', () => {
    expect(metaConcurrency(null)).toBe(1);
    expect(metaConcurrency(undefined)).toBe(1);
  });

  it('is 1 when warm pools are disabled', () => {
    expect(metaConcurrency(status({ enabled: false }))).toBe(1);
  });

  it('uses the general pool size for an unspecified purpose', () => {
    expect(metaConcurrency(status())).toBe(5);
  });

  it('uses the matching purpose pool size when present', () => {
    const s = status({
      pools: [
        pool({ purpose: GENERAL_PURPOSE, size: 5 }),
        pool({ purpose: 'review', size: 3 }),
      ],
    });
    expect(metaConcurrency(s, 'review')).toBe(3);
  });

  it('falls back to the general pool when the purpose has no pool', () => {
    const s = status({
      pools: [pool({ purpose: GENERAL_PURPOSE, size: 4 })],
    });
    expect(metaConcurrency(s, 'review')).toBe(4);
  });

  it('is 1 when no matching or general pool exists', () => {
    const s = status({ pools: [pool({ purpose: 'review', size: 3 })] });
    expect(metaConcurrency(s, 'other')).toBe(1);
  });

  it('never returns less than 1 even for a zero-sized pool', () => {
    const s = status({ pools: [pool({ purpose: GENERAL_PURPOSE, size: 0 })] });
    expect(metaConcurrency(s)).toBe(1);
  });
});
