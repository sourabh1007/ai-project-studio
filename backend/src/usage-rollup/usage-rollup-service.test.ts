import { describe, expect, it } from 'vitest';
import {
  createUsageRollupService,
  isoWeekBounds,
  parseGranularity,
  periodBounds,
  rollupUsage,
} from './usage-rollup-service.js';
import type { UsageDayRow, UsageRollupReader } from './usage-rollup-contract.js';

function row(overrides: Partial<UsageDayRow>): UsageDayRow {
  return {
    day: '2026-09-14',
    provider: 'copilot',
    model: 'gpt-5.4',
    sessions: 1,
    inputTokens: 10,
    outputTokens: 4,
    reasoningOutputTokens: 1,
    cost: 0,
    credits: 2,
    nanoAiu: 100,
    ...overrides,
  };
}

describe('periodBounds', () => {
  it('returns the day itself at day granularity', () => {
    expect(periodBounds('2026-09-14', 'day')).toEqual({
      key: '2026-09-14',
      start: '2026-09-14',
      end: '2026-09-14',
      label: '2026-09-14',
    });
  });

  it('buckets a month with its true last day', () => {
    expect(periodBounds('2026-09-14', 'month')).toEqual({
      key: '2026-09',
      start: '2026-09-01',
      end: '2026-09-30',
      label: '2026-09',
    });
  });

  it('uses the leap-year length for February', () => {
    expect(periodBounds('2024-02-10', 'month').end).toBe('2024-02-29');
    expect(periodBounds('2023-02-10', 'month').end).toBe('2023-02-28');
  });

  it('buckets a whole calendar year', () => {
    expect(periodBounds('2026-09-14', 'year')).toEqual({
      key: '2026',
      start: '2026-01-01',
      end: '2026-12-31',
      label: '2026',
    });
  });

  it('delegates week granularity to ISO week bounds', () => {
    expect(periodBounds('2021-01-04', 'week')).toEqual(isoWeekBounds('2021-01-04'));
  });
});

describe('isoWeekBounds', () => {
  it('numbers the first ISO week of the year', () => {
    expect(isoWeekBounds('2021-01-04')).toEqual({
      key: '2021-W01',
      start: '2021-01-04',
      end: '2021-01-10',
      label: '2021-W01',
    });
  });

  it('rolls an early-January day into the prior ISO year', () => {
    expect(isoWeekBounds('2021-01-01')).toEqual({
      key: '2020-W53',
      start: '2020-12-28',
      end: '2021-01-03',
      label: '2020-W53',
    });
  });
});

describe('rollupUsage', () => {
  it('sums grand totals across every row', () => {
    const result = rollupUsage(
      [row({ credits: 2, nanoAiu: 100 }), row({ credits: 3, nanoAiu: 50 })],
      'month',
      'workspace',
    );
    expect(result.scope).toBe('workspace');
    expect(result.granularity).toBe('month');
    expect(result.totals.credits).toBe(5);
    expect(result.totals.nanoAiu).toBe(150);
    expect(result.totals.sessions).toBe(2);
  });

  it('groups rows into sorted period buckets', () => {
    const result = rollupUsage(
      [
        row({ day: '2026-09-30', credits: 1 }),
        row({ day: '2026-08-01', credits: 4 }),
        row({ day: '2026-09-02', credits: 1 }),
      ],
      'month',
      'workspace',
    );
    expect(result.periods.map((p) => p.key)).toEqual(['2026-08', '2026-09']);
    expect(result.periods[1].credits).toBe(2);
    expect(result.periods[1].start).toBe('2026-09-01');
  });

  it('breaks down by model and provider sorted by credits then name', () => {
    const result = rollupUsage(
      [
        row({ model: 'a', provider: 'p1', nanoAiu: 10 }),
        row({ model: 'b', provider: 'p2', nanoAiu: 30 }),
        row({ model: 'a', provider: 'p1', nanoAiu: 5 }),
      ],
      'year',
      'ide',
    );
    expect(result.byModel.map((m) => m.model)).toEqual(['b', 'a']);
    expect(result.byModel[1].nanoAiu).toBe(15);
    expect(result.byProvider.map((p) => p.provider)).toEqual(['p2', 'p1']);
  });

  it('sorts period buckets chronologically regardless of encounter order', () => {
    const result = rollupUsage(
      [
        row({ day: '2026-08-01' }),
        row({ day: '2026-10-01' }),
        row({ day: '2026-09-01' }),
      ],
      'month',
      'workspace',
    );
    expect(result.periods.map((p) => p.key)).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('breaks a nanoAiu tie by name for models and providers', () => {
    const result = rollupUsage(
      [
        row({ model: 'z', provider: 'pz', nanoAiu: 20 }),
        row({ model: 'a', provider: 'pa', nanoAiu: 20 }),
      ],
      'year',
      'ide',
    );
    expect(result.byModel.map((m) => m.model)).toEqual(['a', 'z']);
    expect(result.byProvider.map((p) => p.provider)).toEqual(['pa', 'pz']);
  });

  it('returns empty structures for no rows', () => {
    const result = rollupUsage([], 'day', 'feature');
    expect(result.totals.credits).toBe(0);
    expect(result.periods).toEqual([]);
    expect(result.byModel).toEqual([]);
    expect(result.byProvider).toEqual([]);
  });
});

describe('parseGranularity', () => {
  it('accepts each supported granularity', () => {
    expect(parseGranularity('day')).toBe('day');
    expect(parseGranularity('week')).toBe('week');
    expect(parseGranularity('month')).toBe('month');
    expect(parseGranularity('year')).toBe('year');
  });

  it('falls back to month for anything unrecognized', () => {
    expect(parseGranularity('decade')).toBe('month');
    expect(parseGranularity(undefined)).toBe('month');
  });
});

describe('createUsageRollupService', () => {
  const reader: UsageRollupReader = {
    workspaceDays: () => [row({ credits: 1 })],
    ideDays: () => [row({ credits: 2 })],
    featureDays: (id) => [row({ credits: id === 'f1' ? 3 : 0 })],
  };
  const service = createUsageRollupService({ reader });

  it('folds each scope through the reader', () => {
    expect(service.workspace('month').scope).toBe('workspace');
    expect(service.workspace('month').totals.credits).toBe(1);
    expect(service.ide('week').scope).toBe('ide');
    expect(service.ide('week').totals.credits).toBe(2);
    const feature = service.feature('f1', 'year');
    expect(feature.scope).toBe('feature');
    expect(feature.granularity).toBe('year');
    expect(feature.totals.credits).toBe(3);
  });
});
