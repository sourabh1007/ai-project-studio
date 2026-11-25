import type { DatabaseSync } from 'node:sqlite';
import type { IdeUsageConfig } from '../ide-usage/config.js';
import { attachMcpTools, mcpRollupSource, mcpToolRollupSource, toMcpBreakdown, type McpRollupRow, type McpToolRollupRow } from './mcp-rollup.js';
import type {
  UsageDayRow,
  UsageRollupReader,
  UsageWindow,
} from '../usage-rollup/usage-rollup-contract.js';

interface DayRow {
  day: string;
  provider: string;
  model: string;
  sessions: number | bigint;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
  reasoningOutputTokens: number | bigint;
  cost: number | null;
  credits: number | null;
  nanoAiu: number | bigint | null;
  usdEstimate: number | null;
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
    cost: row.cost === null ? null : Number(row.cost),
    credits: row.credits === null ? null : Number(row.credits),
    nanoAiu: row.nanoAiu === null ? null : Number(row.nanoAiu),
    ...(row.usdEstimate === null ? {} : { usdEstimate: row.usdEstimate }),
  };
}

/** Live CLI turns, normalized to the shared day-grained row shape. */
export function cliSource(filter: string): string {
  return `SELECT substr(started_at, 1, 10) AS day, provider AS provider,
      resolved_model AS model, session_id AS session_id,
      input_tokens AS input_tokens, output_tokens AS output_tokens,
      reasoning_output_tokens AS reasoning_output_tokens, cost AS cost,
      credits AS credits, nano_aiu AS nano_aiu, usd_estimate
    FROM usage_events WHERE ${filter}`;
}

/** Warm-ACP meta snapshots (no cost/reasoning columns), normalized. */
export function metaSource(filter: string): string {
  return `SELECT substr(captured_at, 1, 10), provider_id,
      COALESCE(resolved_model, requested_model), session_id,
      COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), 0,
      CASE WHEN credits IS NULL THEN NULL ELSE 0 END, credits, nano_aiu, NULL
    FROM meta_usage_records WHERE ${filter}`;
}

/** Summarized usage retained from deleted sessions/features, normalized. */
export function retainedSource(filter: string): string {
  return `SELECT day, provider, resolved_model, session_id, input_tokens,
      output_tokens, reasoning_output_tokens, cost, credits, nano_aiu, usd_estimate
    FROM retained_usage WHERE ${filter}`;
}

/** Wraps a UNION ALL source in the shared day/provider/model grouping. */
function grouped(union: string): string {
  return `SELECT day, provider, model,
      COUNT(DISTINCT session_id) AS sessions,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
      CASE WHEN COUNT(*) = COUNT(cost) THEN COALESCE(SUM(cost), 0) END AS cost,
      CASE WHEN COUNT(*) = COUNT(credits) THEN COALESCE(SUM(credits), 0) END AS credits,
      CASE WHEN COUNT(*) = COUNT(nano_aiu) THEN COALESCE(SUM(nano_aiu), 0) END AS nanoAiu,
      SUM(usd_estimate) AS usdEstimate
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

  // Preserve legacy proxy scope lookup; observed calls carry scope explicitly,
  // including warm internal sessions with no row in the sessions table.
  const workspaceMcpStmt = db.prepare(
    mcpRollupSource(`NOT EXISTS (
      SELECT 1 FROM sessions
      WHERE sessions.id = mcp_server_usage.session_id
        AND sessions.scope = 'internal'
    )`, "scope = 'feature'"),
  );
  const ideMcpStmt = db.prepare(
    mcpRollupSource(`EXISTS (
      SELECT 1 FROM usage_events
      WHERE usage_events.session_id = mcp_server_usage.session_id
        AND usage_events.kind IN (${metaKindPlaceholders})
    )`, "scope = 'internal'"),
  );
  const featureMcpStmt = db.prepare(mcpRollupSource('feature_id = ?', 'feature_id = ?'));
  const workspaceMcpToolsStmt = db.prepare(mcpToolRollupSource("scope = 'feature'"));
  const ideMcpToolsStmt = db.prepare(mcpToolRollupSource("scope = 'internal'"));
  const featureMcpToolsStmt = db.prepare(mcpToolRollupSource('feature_id = ?'));
  const boundedMcp = (proxy: string, observed: string, proxyArgs: string[], observedArgs: string[], window: UsageWindow) => {
    const bounds = [window.from, window.to];
    const range = ' AND recorded_at >= ? AND recorded_at < ?';
    const servers = (db.prepare(mcpRollupSource(`(${proxy})${range}`, `(${observed})${range}`))
      .all(...proxyArgs, ...bounds, ...observedArgs, ...bounds) as unknown as McpRollupRow[]).map(toMcpBreakdown);
    return attachMcpTools(servers, db.prepare(mcpToolRollupSource(`(${observed})${range}`))
      .all(...observedArgs, ...bounds) as unknown as McpToolRollupRow[]);
  };

  return {
    workspaceDays(window) {
      if (window) return (db.prepare(grouped(
        `${cliSource(`${visibleUsage} AND started_at >= ? AND started_at < ?`)}
         UNION ALL ${retainedSource("source = 'cli' AND scope = 'feature' AND day >= ? AND day < ?")}`,
      )).all(window.from, window.to, window.from, window.to) as unknown as DayRow[]).map(toDayRow);
      return (workspaceStmt.all() as unknown as DayRow[]).map(toDayRow);
    },
    ideDays(window) {
      if (window) return (db.prepare(grouped(
        `${cliSource(`kind IN (${metaKindPlaceholders}) AND started_at >= ? AND started_at < ?`)}
         UNION ALL ${metaSource('captured_at >= ? AND captured_at < ?')}
         UNION ALL ${retainedSource("(source = 'meta' OR scope = 'internal') AND day >= ? AND day < ?")}`,
      )).all(...metaKinds, window.from, window.to, window.from, window.to, window.from, window.to) as unknown as DayRow[]).map(toDayRow);
      return (ideStmt.all(...metaKinds) as unknown as DayRow[]).map(toDayRow);
    },
    featureDays(featureId, window) {
      if (window) return (db.prepare(grouped(
        `${cliSource('feature_id = ? AND started_at >= ? AND started_at < ?')}
         UNION ALL ${metaSource('feature_id = ? AND captured_at >= ? AND captured_at < ?')}
         UNION ALL ${retainedSource('feature_id = ? AND day >= ? AND day < ?')}`,
      )).all(featureId, window.from, window.to, featureId, window.from, window.to,
        featureId, window.from, window.to) as unknown as DayRow[]).map(toDayRow);
      return (
        featureStmt.all(featureId, featureId, featureId) as unknown as DayRow[]
      ).map(toDayRow);
    },
    workspaceMcpServers(window) {
      if (window) return boundedMcp(`NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = mcp_server_usage.session_id AND sessions.scope = 'internal')`,
        "scope = 'feature'", [], [], window);
      const servers = (workspaceMcpStmt.all() as unknown as McpRollupRow[]).map(toMcpBreakdown);
      return attachMcpTools(servers, workspaceMcpToolsStmt.all() as unknown as McpToolRollupRow[]);
    },
    ideMcpServers(window) {
      if (window) return boundedMcp(`EXISTS (SELECT 1 FROM usage_events WHERE usage_events.session_id = mcp_server_usage.session_id AND usage_events.kind IN (${metaKindPlaceholders}))`,
        "scope = 'internal'", [...metaKinds], [], window);
      const servers = (ideMcpStmt.all(...metaKinds) as unknown as McpRollupRow[]).map(
        toMcpBreakdown,
      );
      return attachMcpTools(servers, ideMcpToolsStmt.all() as unknown as McpToolRollupRow[]);
    },
    featureMcpServers(featureId, window) {
      if (window) return boundedMcp('feature_id = ?', 'feature_id = ?', [featureId], [featureId], window);
      const servers = (featureMcpStmt.all(featureId, featureId) as unknown as McpRollupRow[]).map(
        toMcpBreakdown,
      );
      return attachMcpTools(servers, featureMcpToolsStmt.all(featureId) as unknown as McpToolRollupRow[]);
    },
  };
}
