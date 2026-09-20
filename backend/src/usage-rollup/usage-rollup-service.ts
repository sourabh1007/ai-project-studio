import type {
  ModelBreakdown,
  ProviderBreakdown,
  UsageTotals,
} from '../aggregation/aggregation-contract.js';
import type {
  UsageDayRow,
  UsageGranularity,
  UsagePeriod,
  UsageRollup,
  UsageRollupReader,
  UsageRollupScope,
} from './usage-rollup-contract.js';

const EMPTY_TOTALS: UsageTotals = {
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  cost: 0,
  credits: 0,
  nanoAiu: 0,
};

function addTotals(base: UsageTotals, row: UsageTotals): UsageTotals {
  return {
    sessions: base.sessions + row.sessions,
    inputTokens: base.inputTokens + row.inputTokens,
    outputTokens: base.outputTokens + row.outputTokens,
    reasoningOutputTokens: base.reasoningOutputTokens + row.reasoningOutputTokens,
    cost: base.cost + row.cost,
    credits: base.credits + row.credits,
    nanoAiu: base.nanoAiu + row.nanoAiu,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function toDay(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Calendar bounds + stable key/label for the bucket a day belongs to. */
interface PeriodBounds {
  key: string;
  start: string;
  end: string;
  label: string;
}

/** ISO-8601 week (Monday-based, week 1 holds the year's first Thursday). */
export function isoWeekBounds(day: string): PeriodBounds {
  const date = parseDay(day);
  const weekday = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - weekday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(`${isoYear}-01-01T00:00:00Z`);
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  const key = `${isoYear}-W${pad(week)}`;
  return { key, start: toDay(monday), end: toDay(sunday), label: key };
}

/** Bucket bounds for a day at the requested granularity. */
export function periodBounds(
  day: string,
  granularity: UsageGranularity,
): PeriodBounds {
  if (granularity === 'day') {
    return { key: day, start: day, end: day, label: day };
  }
  if (granularity === 'week') {
    return isoWeekBounds(day);
  }
  const [year, month] = day.split('-');
  if (granularity === 'month') {
    const end = toDay(new Date(Date.UTC(Number(year), Number(month), 0)));
    return { key: `${year}-${month}`, start: `${year}-${month}-01`, end, label: `${year}-${month}` };
  }
  return { key: year, start: `${year}-01-01`, end: `${year}-12-31`, label: year };
}

/** Sums grouped by a string key, preserving first-seen labels/metadata. */
function foldBy<T>(
  rows: readonly UsageDayRow[],
  keyOf: (row: UsageDayRow) => string,
  make: (key: string, totals: UsageTotals) => T,
): T[] {
  const byKey = new Map<string, UsageTotals>();
  const order: string[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, addTotals(existing, row));
    } else {
      byKey.set(key, addTotals(EMPTY_TOTALS, row));
      order.push(key);
    }
  }
  return order.map((key) => make(key, byKey.get(key) as UsageTotals));
}

/**
 * Pure fold of day-grained rows into a consolidated rollup: period buckets at
 * the requested granularity plus model/provider breakdowns and grand totals.
 * `sessions` is a per-bucket distinct approximation (rows already collapse a
 * session that spans days/models), matching the existing daily rollups.
 */
export function rollupUsage(
  rows: readonly UsageDayRow[],
  granularity: UsageGranularity,
  scope: UsageRollupScope,
): UsageRollup {
  const boundsFor = new Map<string, PeriodBounds>();
  const periodTotals = new Map<string, UsageTotals>();
  const periodOrder: string[] = [];
  let totals = { ...EMPTY_TOTALS };

  for (const row of rows) {
    totals = addTotals(totals, row);
    const bounds = periodBounds(row.day, granularity);
    const current = periodTotals.get(bounds.key);
    if (current) {
      periodTotals.set(bounds.key, addTotals(current, row));
    } else {
      boundsFor.set(bounds.key, bounds);
      periodTotals.set(bounds.key, addTotals(EMPTY_TOTALS, row));
      periodOrder.push(bounds.key);
    }
  }

  const periods: UsagePeriod[] = periodOrder
    .map((key) => {
      const bounds = boundsFor.get(key) as PeriodBounds;
      return { ...bounds, ...(periodTotals.get(key) as UsageTotals) };
    })
    .sort((a, b) => (a.start < b.start ? -1 : 1));

  const byModel = foldBy(
    rows,
    (row) => row.model,
    (model, sums): ModelBreakdown => ({ model, ...sums }),
  ).sort((a, b) => b.nanoAiu - a.nanoAiu || a.model.localeCompare(b.model));

  const byProvider = foldBy(
    rows,
    (row) => row.provider,
    (provider, sums): ProviderBreakdown => ({ provider, ...sums }),
  ).sort((a, b) => b.nanoAiu - a.nanoAiu || a.provider.localeCompare(b.provider));

  return { scope, granularity, totals, periods, byModel, byProvider, byMcpServer: [] };
}

const GRANULARITIES: readonly UsageGranularity[] = ['day', 'week', 'month', 'year'];

/**
 * Coerces an untrusted query value to a supported granularity, falling back to
 * `month` (the default landing view) for anything unrecognized.
 */
export function parseGranularity(value: unknown): UsageGranularity {
  return GRANULARITIES.includes(value as UsageGranularity)
    ? (value as UsageGranularity)
    : 'month';
}

/** Consolidated usage rollups per scope, folded to a chosen granularity. */
export interface UsageRollupService {
  workspace(granularity: UsageGranularity): UsageRollup;
  ide(granularity: UsageGranularity): UsageRollup;
  feature(featureId: string, granularity: UsageGranularity): UsageRollup;
}

export interface UsageRollupServiceDeps {
  reader: UsageRollupReader;
}

export function createUsageRollupService(
  deps: UsageRollupServiceDeps,
): UsageRollupService {
  return {
    workspace(granularity) {
      return {
        ...rollupUsage(deps.reader.workspaceDays(), granularity, 'workspace'),
        byMcpServer: deps.reader.workspaceMcpServers(),
      };
    },
    ide(granularity) {
      return {
        ...rollupUsage(deps.reader.ideDays(), granularity, 'ide'),
        byMcpServer: deps.reader.ideMcpServers(),
      };
    },
    feature(featureId, granularity) {
      return {
        ...rollupUsage(
          deps.reader.featureDays(featureId),
          granularity,
          'feature',
        ),
        byMcpServer: deps.reader.featureMcpServers(featureId),
      };
    },
  };
}
