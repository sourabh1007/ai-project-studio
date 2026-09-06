import { describe, expect, it } from 'vitest';
import type { ConfigValue, MetaSessionTurn } from './types.js';
import {
  formatClock,
  formatDuration,
  formatTokens,
  purposeLabel,
  readWarmPool,
  sessionSeq,
  turnWork,
} from './metasession-format.js';

function turn(overrides: Partial<MetaSessionTurn> = {}): MetaSessionTurn {
  return {
    at: 0,
    purpose: 'general',
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

describe('readWarmPool', () => {
  it('rejects null and non-object values', () => {
    expect(readWarmPool(null)).toBeNull();
    expect(readWarmPool('nope' as ConfigValue)).toBeNull();
  });

  it('rejects objects missing a boolean enabled or an array of pools', () => {
    expect(readWarmPool({ pools: [] } as unknown as ConfigValue)).toBeNull();
    expect(
      readWarmPool({ enabled: true } as unknown as ConfigValue),
    ).toBeNull();
  });

  it('returns the config when well-formed', () => {
    const value = {
      enabled: true,
      pools: [{ purpose: 'general', size: 2 }],
    } as unknown as ConfigValue;
    expect(readWarmPool(value)).toEqual({
      enabled: true,
      pools: [{ purpose: 'general', size: 2 }],
    });
  });
});

describe('sessionSeq', () => {
  it('reads the trailing number of a prefixed id', () => {
    expect(sessionSeq('meta-12')).toBe(12);
  });

  it('falls back to 0 when there is no number', () => {
    expect(sessionSeq('meta-')).toBe(0);
  });
});

describe('formatDuration', () => {
  it.each([
    [500, '0s'],
    [5000, '5s'],
    [65000, '1m 5s'],
    [3661000, '1h 1m 1s'],
  ])('formats %ims as "%s"', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatClock / formatTokens', () => {
  it('renders a clock string for an epoch time', () => {
    expect(typeof formatClock(0)).toBe('string');
    expect(formatClock(0).length).toBeGreaterThan(0);
  });

  it('formats token counts with grouping', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1234)).toMatch(/1.?234/);
  });
});

describe('purposeLabel / turnWork', () => {
  it('labels a known purpose and passes through an unknown one', () => {
    expect(purposeLabel('general')).toBe('General');
    expect(purposeLabel('mystery')).toBe('mystery');
  });

  it('prefers a turn label and falls back to the purpose label', () => {
    expect(turnWork(turn({ label: 'Repository analysis' }))).toBe(
      'Repository analysis',
    );
    expect(turnWork(turn({ purpose: 'general' }))).toBe('General');
  });
});
