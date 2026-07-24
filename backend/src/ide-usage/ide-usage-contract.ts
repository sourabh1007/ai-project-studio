import type {
  DailyBreakdown,
  ModelBreakdown,
  UsageTotals,
} from '../aggregation/aggregation-contract.js';

/** Read-side contracts for the IDE's own AI (meta-session) usage. */

/** Complete IDE AI-usage payload: meta totals plus optional breakdowns. */
export interface IdeUsage {
  totals: UsageTotals;
  byModel: ModelBreakdown[];
  byDay: DailyBreakdown[];
}

/**
 * Read port exposing meta-session usage rollups. Deliberately separate from the
 * dev-cost AggregateReader so IDE overhead is reported independently and the
 * existing feature/workspace rollups stay untouched.
 */
export interface IdeUsageReader {
  totals(): UsageTotals;
  byModel(): ModelBreakdown[];
  byDay(): DailyBreakdown[];
}
