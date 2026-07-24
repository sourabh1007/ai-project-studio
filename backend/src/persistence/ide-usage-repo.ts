import type { DatabaseSync } from 'node:sqlite';
import type {
  DailyBreakdown,
  ModelBreakdown,
  UsageTotals,
} from '../aggregation/aggregation-contract.js';
import type { IdeUsageReader } from '../ide-usage/ide-usage-contract.js';
import type { IdeUsageConfig } from '../ide-usage/config.js';

const TOTALS_COLUMNS = `
  COUNT(DISTINCT session_id) AS sessions,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
  COALESCE(SUM(cost), 0) AS cost,
  COALESCE(SUM(credits), 0) AS credits,
  COALESCE(SUM(nano_aiu), 0) AS nanoAiu
`;

interface TotalsRow {
  sessions: number | bigint;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
  reasoningOutputTokens: number | bigint;
  cost: number;
  credits: number;
  nanoAiu: number | bigint;
}

function toTotals(row: TotalsRow): UsageTotals {
  return {
    sessions: Number(row.sessions),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    reasoningOutputTokens: Number(row.reasoningOutputTokens),
    cost: Number(row.cost),
    credits: Number(row.credits),
    nanoAiu: Number(row.nanoAiu),
  };
}

/**
 * SQLite-backed read port for the IDE's own AI usage. Filters usage events to
 * the configured meta kinds only, mirroring the dev-cost aggregate-repo shape
 * while remaining fully independent of it.
 */
export function createIdeUsageRepo(
  db: DatabaseSync,
  config: IdeUsageConfig,
): IdeUsageReader {
  const kinds = config.metaKinds;
  const placeholders = kinds.map(() => '?').join(', ');
  const filter = `kind IN (${placeholders})`;

  const totalsStmt = db.prepare(
    `SELECT ${TOTALS_COLUMNS} FROM usage_events WHERE ${filter}`,
  );
  const byModelStmt = db.prepare(
    `SELECT resolved_model AS model, ${TOTALS_COLUMNS} FROM usage_events
     WHERE ${filter} GROUP BY resolved_model ORDER BY resolved_model`,
  );
  const byDayStmt = db.prepare(
    `SELECT substr(started_at, 1, 10) AS day, ${TOTALS_COLUMNS} FROM usage_events
     WHERE ${filter} GROUP BY day ORDER BY day`,
  );

  return {
    totals() {
      return toTotals(totalsStmt.get(...kinds) as unknown as TotalsRow);
    },
    byModel() {
      return (
        byModelStmt.all(...kinds) as unknown as (TotalsRow & { model: string })[]
      ).map((row): ModelBreakdown => ({ model: row.model, ...toTotals(row) }));
    },
    byDay() {
      return (
        byDayStmt.all(...kinds) as unknown as (TotalsRow & { day: string })[]
      ).map((row): DailyBreakdown => ({ day: row.day, ...toTotals(row) }));
    },
  };
}
