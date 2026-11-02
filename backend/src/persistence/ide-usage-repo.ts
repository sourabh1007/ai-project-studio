import type { DatabaseSync } from 'node:sqlite';
import type {
  DailyBreakdown,
  ModelBreakdown,
  UsageTotals,
} from '../aggregation/aggregation-contract.js';
import type { IdeUsageReader } from '../ide-usage/ide-usage-contract.js';
import type { IdeUsageConfig } from '../ide-usage/config.js';
import { cliSource, metaSource, retainedSource } from './usage-rollup-repo.js';

const TOTALS_COLUMNS = `
  COUNT(DISTINCT session_id) AS sessions,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
  CASE WHEN COUNT(*) = COUNT(cost) THEN COALESCE(SUM(cost), 0) END AS cost,
  CASE WHEN COUNT(*) = COUNT(credits) THEN COALESCE(SUM(credits), 0) END AS credits,
  CASE WHEN COUNT(*) = COUNT(nano_aiu) THEN COALESCE(SUM(nano_aiu), 0) END AS nanoAiu
`;

interface TotalsRow {
  sessions: number | bigint;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
  reasoningOutputTokens: number | bigint;
  cost: number | null;
  credits: number | null;
  nanoAiu: number | bigint | null;
}

function toTotals(row: TotalsRow): UsageTotals {
  return {
    sessions: Number(row.sessions),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    reasoningOutputTokens: Number(row.reasoningOutputTokens),
    cost: row.cost === null ? null : Number(row.cost),
    credits: row.credits === null ? null : Number(row.credits),
    nanoAiu: row.nanoAiu === null ? null : Number(row.nanoAiu),
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
  // Same sources as the IDE rollup (live, warm-ACP and retained-after-delete)
  // so the status bar never drops usage the analytics view still counts.
  const union = `${cliSource(`kind IN (${placeholders})`)}
    UNION ALL
    ${metaSource('1 = 1')}
    UNION ALL
    ${retainedSource("source = 'meta' OR scope = 'internal'")}`;

  const totalsStmt = db.prepare(`SELECT ${TOTALS_COLUMNS} FROM (${union})`);
  const byModelStmt = db.prepare(
    `SELECT model, ${TOTALS_COLUMNS} FROM (${union}) GROUP BY model ORDER BY model`,
  );
  const byDayStmt = db.prepare(
    `SELECT day, ${TOTALS_COLUMNS} FROM (${union}) GROUP BY day ORDER BY day`,
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
