import type { DatabaseSync } from 'node:sqlite';
import type { IdeUsageConfig } from '../ide-usage/config.js';
import type { McpServerBreakdown } from '../aggregation/aggregation-contract.js';
import type {
  UsageDayRow,
  UsageRollupReader,
} from '../usage-rollup/usage-rollup-contract.js';

interface DayRow {
  day: string;
  provider: string;
  model: string;
  sessions: number | bigint;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
  reasoningOutputTokens: number | bigint;
  cost: number;
  credits: number;
  nanoAiu: number | bigint;
}

interface McpRow {
  server: string;
  calls: number | bigint;
  inputBytes: number | bigint;
  outputBytes: number | bigint;
  durationMs: number | bigint;
}

function toMcpBreakdown(row: McpRow): McpServerBreakdown {
  return {
    server: row.server,
    calls: Number(row.calls),
    inputBytes: Number(row.inputBytes),
    outputBytes: Number(row.outputBytes),
    durationMs: Number(row.durationMs),
  };
}

/** Per-server MCP tool-call I/O rollup, filtered to a scope's session set. */
function mcpSource(filter: string): string {
  return `SELECT server AS server,
      COALESCE(SUM(calls), 0) AS calls,
      COALESCE(SUM(input_bytes), 0) AS inputBytes,
      COALESCE(SUM(output_bytes), 0) AS outputBytes,
      COALESCE(SUM(duration_ms), 0) AS durationMs
    FROM mcp_server_usage
    WHERE ${filter}
    GROUP BY server ORDER BY server`;
}

function toDayRow(row: DayRow): UsageDayRow {
  return {
    day: row.day,
    provider: row.provider,
    model: row.model,
    sessions: Number(row.sessions),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    reasoningOutputTokens: Number(row.reasoningOutputTokens),
    cost: Number(row.cost),
    credits: Number(row.credits),
    nanoAiu: Number(row.nanoAiu),
  };
}

/** Live CLI turns, normalized to the shared day-grained row shape. */
function cliSource(filter: string): string {
  return `SELECT substr(started_at, 1, 10) AS day, provider AS provider,
      resolved_model AS model, session_id AS session_id,
      input_tokens AS input_tokens, output_tokens AS output_tokens,
      reasoning_output_tokens AS reasoning_output_tokens, cost AS cost,
      credits AS credits, nano_aiu AS nano_aiu
    FROM usage_events WHERE ${filter}`;
}

/** Warm-ACP meta snapshots (no cost/reasoning columns), normalized. */
function metaSource(filter: string): string {
  return `SELECT substr(captured_at, 1, 10), provider_id,
      COALESCE(resolved_model, requested_model), session_id,
      COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), 0,
      0, COALESCE(credits, 0), COALESCE(nano_aiu, 0)
    FROM meta_usage_records WHERE ${filter}`;
}

/** Summarized usage retained from deleted sessions/features, normalized. */
function retainedSource(filter: string): string {
  return `SELECT day, provider, resolved_model, session_id, input_tokens,
      output_tokens, reasoning_output_tokens, cost, credits, nano_aiu
    FROM retained_usage WHERE ${filter}`;
}

/** Wraps a UNION ALL source in the shared day/provider/model grouping. */
function grouped(union: string): string {
  return `SELECT day, provider, model,
      COUNT(DISTINCT session_id) AS sessions,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
      COALESCE(SUM(cost), 0) AS cost,
      COALESCE(SUM(credits), 0) AS credits,
      COALESCE(SUM(nano_aiu), 0) AS nanoAiu
    FROM (${union})
    GROUP BY day, provider, model
    ORDER BY day, provider, model`;
}

/**
 * SQLite-backed {@link UsageRollupReader}. Emits day-grained rows unioned across
 * every usage source so the pure rollup service can bucket them by week/month/
 * year. Scope selection mirrors the existing readers: workspace is billable dev
 * usage (non-internal live turns + retained feature usage), IDE is the app's own
 * metasession overhead (meta kinds + all warm-ACP records + retained IDE usage),
 * and feature is everything attributed to a feature including retained deletions.
 */
export function createUsageRollupRepo(
  db: DatabaseSync,
  ideUsageConfig: IdeUsageConfig,
): UsageRollupReader {
  const metaKinds = ideUsageConfig.metaKinds;
  const metaKindPlaceholders = metaKinds.map(() => '?').join(', ');

  const visibleUsage = `NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE sessions.id = usage_events.session_id
      AND sessions.scope = 'internal'
  )`;

  const workspaceStmt = db.prepare(
    grouped(
      `${cliSource(visibleUsage)}
       UNION ALL
       ${retainedSource("source = 'cli' AND scope = 'feature'")}`,
    ),
  );
  const ideStmt = db.prepare(
    grouped(
      `${cliSource(`kind IN (${metaKindPlaceholders})`)}
       UNION ALL
       ${metaSource('1 = 1')}
       UNION ALL
       ${retainedSource("source = 'meta' OR scope = 'internal'")}`,
    ),
  );
  const featureStmt = db.prepare(
    grouped(
      `${cliSource('feature_id = ?')}
       UNION ALL
       ${metaSource('feature_id = ?')}
       UNION ALL
       ${retainedSource('feature_id = ?')}`,
    ),
  );

  // MCP tool-call I/O is measured per server by the launch proxy and tagged
  // with the driving feature/session. Scope it to match each token rollup:
  //   • workspace → sessions that are not internal-scoped (billable dev work),
  //   • ide       → sessions whose usage events are a meta kind (IDE overhead),
  //   • feature   → everything tagged with the feature id.
  // NULL session ids stay in the workspace slice (unattributable-but-visible)
  // and out of the IDE slice (cannot be proven to be metasession traffic).
  const workspaceMcpStmt = db.prepare(
    mcpSource(`NOT EXISTS (
      SELECT 1 FROM sessions
      WHERE sessions.id = mcp_server_usage.session_id
        AND sessions.scope = 'internal'
    )`),
  );
  const ideMcpStmt = db.prepare(
    mcpSource(`EXISTS (
      SELECT 1 FROM usage_events
      WHERE usage_events.session_id = mcp_server_usage.session_id
        AND usage_events.kind IN (${metaKindPlaceholders})
    )`),
  );
  const featureMcpStmt = db.prepare(mcpSource('feature_id = ?'));

  return {
    workspaceDays() {
      return (workspaceStmt.all() as unknown as DayRow[]).map(toDayRow);
    },
    ideDays() {
      return (ideStmt.all(...metaKinds) as unknown as DayRow[]).map(toDayRow);
    },
    featureDays(featureId) {
      return (
        featureStmt.all(featureId, featureId, featureId) as unknown as DayRow[]
      ).map(toDayRow);
    },
    workspaceMcpServers() {
      return (workspaceMcpStmt.all() as unknown as McpRow[]).map(toMcpBreakdown);
    },
    ideMcpServers() {
      return (ideMcpStmt.all(...metaKinds) as unknown as McpRow[]).map(
        toMcpBreakdown,
      );
    },
    featureMcpServers(featureId) {
      return (featureMcpStmt.all(featureId) as unknown as McpRow[]).map(
        toMcpBreakdown,
      );
    },
  };
}
