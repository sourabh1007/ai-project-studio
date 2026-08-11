import type { DatabaseSync } from 'node:sqlite';
import type {
  AggregateReader,
  UsageTotals,
  ModelBreakdown,
  ProviderBreakdown,
  DailyBreakdown,
  SessionUsage,
} from '../aggregation/aggregation-contract.js';
import type { AggregationConfig } from '../aggregation/config.js';

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

/** SQLite-backed implementation of the AggregateReader read port. */
export function createAggregateRepo(
  db: DatabaseSync,
  config: AggregationConfig,
): AggregateReader {
  const kinds = config.rollupKinds;
  const kindsPlaceholders = kinds.map(() => '?').join(', ');
  // Session scope is persisted once on launch. Joining it here avoids copying
  // visibility onto every usage row. Internal-scope work (PR review, summaries,
  // repository analysis) is IDE AI the app runs on the user's behalf: it is kept
  // OUT of the workspace-wide "billable" total, but it IS counted in per-feature
  // analytics so a feature's usage tree shows the real credits its sessions spent
  // (the feature dashboard lists those sessions and must reconcile with them).
  const visibleUsage = `NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.id = usage_events.session_id
      AND sessions.scope = 'internal'
  )`;
  const featureFilter = `feature_id = ? AND kind IN (${kindsPlaceholders})`;

  const featureTotalsStmt = db.prepare(
    `SELECT ${TOTALS_COLUMNS} FROM usage_events WHERE ${featureFilter}`,
  );
  const workspaceTotalsStmt = db.prepare(
    `SELECT ${TOTALS_COLUMNS} FROM usage_events
     WHERE kind IN (${kindsPlaceholders}) AND ${visibleUsage}`,
  );
  const byModelStmt = db.prepare(
    `SELECT resolved_model AS model, ${TOTALS_COLUMNS} FROM usage_events
     WHERE ${featureFilter} GROUP BY resolved_model ORDER BY resolved_model`,
  );
  const byProviderStmt = db.prepare(
    `SELECT provider AS provider, ${TOTALS_COLUMNS} FROM usage_events
     WHERE ${featureFilter} GROUP BY provider ORDER BY provider`,
  );
  const byDayStmt = db.prepare(
    `SELECT substr(started_at, 1, 10) AS day, ${TOTALS_COLUMNS} FROM usage_events
     WHERE ${featureFilter} GROUP BY day ORDER BY day`,
  );
  const bySessionStmt = db.prepare(
    `SELECT session_id AS sessionId, ${TOTALS_COLUMNS} FROM usage_events
     WHERE ${featureFilter} GROUP BY session_id ORDER BY MIN(started_at), session_id`,
  );

  return {
    featureTotals(featureId) {
      return toTotals(featureTotalsStmt.get(featureId, ...kinds) as unknown as TotalsRow);
    },
    workspaceTotals() {
      return toTotals(workspaceTotalsStmt.get(...kinds) as unknown as TotalsRow);
    },
    byModel(featureId) {
      return (byModelStmt.all(featureId, ...kinds) as unknown as (TotalsRow & { model: string })[]).map(
        (row): ModelBreakdown => ({ model: row.model, ...toTotals(row) }),
      );
    },
    byProvider(featureId) {
      return (
        byProviderStmt.all(featureId, ...kinds) as unknown as (TotalsRow & { provider: string })[]
      ).map((row): ProviderBreakdown => ({ provider: row.provider, ...toTotals(row) }));
    },
    byDay(featureId) {
      return (byDayStmt.all(featureId, ...kinds) as unknown as (TotalsRow & { day: string })[]).map(
        (row): DailyBreakdown => ({ day: row.day, ...toTotals(row) }),
      );
    },
    bySession(featureId) {
      return (
        bySessionStmt.all(featureId, ...kinds) as unknown as (TotalsRow & { sessionId: string })[]
      ).map((row): SessionUsage => ({ sessionId: row.sessionId, ...toTotals(row) }));
    },
  };
}
