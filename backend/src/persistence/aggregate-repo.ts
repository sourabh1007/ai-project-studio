import type { DatabaseSync } from 'node:sqlite';
import type {
  AggregateReader,
  UsageTotals,
  ModelBreakdown,
  ProviderBreakdown,
  DailyBreakdown,
  McpServerBreakdown,
  SessionUsage,
  WarmAgentSession,
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
  // Per-feature usage source. `usage_events` holds every turn from real
  // sessions, including the cold metasessions agents spawn. Warm-ACP agent runs
  // reuse a pooled session, so their usage is never captured as per-feature
  // usage_events — it is snapshotted into `meta_usage_records` (one row per
  // completed warm operation, tagged with the driving feature). Both stores are
  // disjoint for any feature (a given run is either cold or warm), so a plain
  // UNION ALL folds warm agent usage into the feature rollups without double
  // counting. `meta_usage_records` carries no reasoning-token or provider-cost
  // detail, so those columns normalize to zero; `credits` is authoritative.
  const featureUsage = (alias: string): string => `(
    SELECT session_id, resolved_model, provider, input_tokens, output_tokens,
           reasoning_output_tokens, cost, credits, nano_aiu, started_at
      FROM usage_events
     WHERE feature_id = ? AND kind IN (${kindsPlaceholders})
    UNION ALL
    SELECT session_id, COALESCE(resolved_model, requested_model) AS resolved_model,
           provider_id AS provider, COALESCE(input_tokens, 0) AS input_tokens,
           COALESCE(output_tokens, 0) AS output_tokens, 0 AS reasoning_output_tokens,
           0 AS cost, COALESCE(credits, 0) AS credits, COALESCE(nano_aiu, 0) AS nano_aiu,
           captured_at AS started_at
      FROM meta_usage_records
     WHERE feature_id = ?
  ) AS ${alias}`;
  // Feature statements bind the feature id twice: once for each half of the
  // union (usage_events with kinds, then meta_usage_records).
  const featureArgs = (featureId: string): Array<string | number> => [
    featureId,
    ...kinds,
    featureId,
  ];

  const featureTotalsStmt = db.prepare(
    `SELECT ${TOTALS_COLUMNS} FROM ${featureUsage('usage')}`,
  );
  const workspaceTotalsStmt = db.prepare(
    `SELECT ${TOTALS_COLUMNS} FROM usage_events
     WHERE kind IN (${kindsPlaceholders}) AND ${visibleUsage}`,
  );
  const byModelStmt = db.prepare(
    `SELECT resolved_model AS model, ${TOTALS_COLUMNS} FROM ${featureUsage('usage')}
     GROUP BY resolved_model ORDER BY resolved_model`,
  );
  const byProviderStmt = db.prepare(
    `SELECT provider AS provider, ${TOTALS_COLUMNS} FROM ${featureUsage('usage')}
     GROUP BY provider ORDER BY provider`,
  );
  const byDayStmt = db.prepare(
    `SELECT substr(started_at, 1, 10) AS day, ${TOTALS_COLUMNS} FROM ${featureUsage('usage')}
     GROUP BY day ORDER BY day`,
  );
  const bySessionStmt = db.prepare(
    `SELECT session_id AS sessionId, ${TOTALS_COLUMNS} FROM ${featureUsage('usage')}
     GROUP BY session_id ORDER BY MIN(started_at), session_id`,
  );
  // Per-MCP-server tool-call I/O for a feature, measured by the launch proxy.
  // These are transport bytes/calls/latency, not model tokens, so they live in
  // their own table and rollup rather than the token columns above.
  const byMcpServerStmt = db.prepare(
    `SELECT server AS server,
            COALESCE(SUM(calls), 0) AS calls,
            COALESCE(SUM(input_bytes), 0) AS inputBytes,
            COALESCE(SUM(output_bytes), 0) AS outputBytes,
            COALESCE(SUM(duration_ms), 0) AS durationMs
       FROM mcp_server_usage
      WHERE feature_id = ?
      GROUP BY server ORDER BY server`,
  );

  // Warm-ACP agent runs for a feature. These reuse a pooled session so they are
  // never persisted as feature `sessions`; their usage lives only in
  // `meta_usage_records` (one row per run). Exposed so analytics can render each
  // agent run as a session row with its captured label.
  const warmAgentSessionsStmt = db.prepare(
    `SELECT session_id AS sessionId, provider_id AS provider, label AS label,
            MAX(captured_at) AS capturedAt
       FROM meta_usage_records
      WHERE feature_id = ?
      GROUP BY session_id
      ORDER BY MAX(captured_at), session_id`,
  );

  return {
    featureTotals(featureId) {
      return toTotals(featureTotalsStmt.get(...featureArgs(featureId)) as unknown as TotalsRow);
    },
    workspaceTotals() {
      return toTotals(workspaceTotalsStmt.get(...kinds) as unknown as TotalsRow);
    },
    byModel(featureId) {
      return (byModelStmt.all(...featureArgs(featureId)) as unknown as (TotalsRow & { model: string })[]).map(
        (row): ModelBreakdown => ({ model: row.model, ...toTotals(row) }),
      );
    },
    byProvider(featureId) {
      return (
        byProviderStmt.all(...featureArgs(featureId)) as unknown as (TotalsRow & { provider: string })[]
      ).map((row): ProviderBreakdown => ({ provider: row.provider, ...toTotals(row) }));
    },
    byDay(featureId) {
      return (byDayStmt.all(...featureArgs(featureId)) as unknown as (TotalsRow & { day: string })[]).map(
        (row): DailyBreakdown => ({ day: row.day, ...toTotals(row) }),
      );
    },
    bySession(featureId) {
      return (
        bySessionStmt.all(...featureArgs(featureId)) as unknown as (TotalsRow & { sessionId: string })[]
      ).map((row): SessionUsage => ({ sessionId: row.sessionId, ...toTotals(row) }));
    },
    warmAgentSessions(featureId) {
      interface WarmRow {
        sessionId: string;
        provider: string;
        label: string | null;
        capturedAt: string;
      }
      return (warmAgentSessionsStmt.all(featureId) as unknown as WarmRow[]).map(
        (row): WarmAgentSession => ({
          sessionId: row.sessionId,
          provider: row.provider,
          label: row.label,
          capturedAt: row.capturedAt,
        }),
      );
    },
    byMcpServer(featureId) {
      interface McpRow {
        server: string;
        calls: number | bigint;
        inputBytes: number | bigint;
        outputBytes: number | bigint;
        durationMs: number | bigint;
      }
      return (byMcpServerStmt.all(featureId) as unknown as McpRow[]).map(
        (row): McpServerBreakdown => ({
          server: row.server,
          calls: Number(row.calls),
          inputBytes: Number(row.inputBytes),
          outputBytes: Number(row.outputBytes),
          durationMs: Number(row.durationMs),
        }),
      );
    },
  };
}
