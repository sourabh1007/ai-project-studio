import type { McpServerBreakdown } from '../aggregation/aggregation-contract.js';
import type { McpOrigin } from '../mcp-usage/mcp-usage-contract.js';

export interface McpRollupRow {
  provider: string;
  server: string;
  origin: McpOrigin;
  calls: number | bigint;
  inputBytes: number | bigint;
  outputBytes: number | bigint;
  durationMs: number | bigint;
}

export function toMcpBreakdown(row: McpRollupRow): McpServerBreakdown {
  return {
    provider: row.provider,
    server: row.server,
    origin: row.origin,
    calls: Number(row.calls),
    inputBytes: Number(row.inputBytes),
    outputBytes: Number(row.outputBytes),
    durationMs: Number(row.durationMs),
    inputTokens: null,
    outputTokens: null,
    nanoAiu: null,
    credits: null,
    attribution: 'unavailable',
  };
}

/** Filters are SQL owned by the readers; caller binds proxy then observed args. */
export function mcpRollupSource(proxyFilter: string, observedFilter: string): string {
  return `SELECT provider, server,
      CASE WHEN MIN(first_origin) = MAX(last_origin)
        THEN MIN(first_origin) ELSE 'unknown' END AS origin,
      SUM(MAX(proxy_calls, observed_calls)) AS calls,
      SUM(input_bytes) AS inputBytes,
      SUM(output_bytes) AS outputBytes,
      SUM(duration_ms) AS durationMs
    FROM (
      SELECT feature_id, session_id, provider, server,
        SUM(proxy_calls) AS proxy_calls, SUM(observed_calls) AS observed_calls,
        SUM(input_bytes) AS input_bytes, SUM(output_bytes) AS output_bytes,
        SUM(duration_ms) AS duration_ms,
        MIN(origin) AS first_origin, MAX(origin) AS last_origin
      FROM (
        SELECT feature_id, session_id, provider, server, calls AS proxy_calls,
          0 AS observed_calls, input_bytes, output_bytes, duration_ms,
          'configured' AS origin
        FROM mcp_server_usage WHERE ${proxyFilter}
        UNION ALL
        SELECT feature_id, session_id, provider, server, 0, 1, 0, 0, 0, origin
        FROM mcp_observed_calls WHERE ${observedFilter}
      )
      GROUP BY feature_id, session_id, provider, server
    )
    GROUP BY provider, server ORDER BY provider, server`;
}
