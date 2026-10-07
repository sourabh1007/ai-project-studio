import type { McpServerBreakdown, McpToolBreakdown } from '../aggregation/aggregation-contract.js';
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

/** One (provider, server, tool) group of observed calls, from the tool rollup. */
export interface McpToolRollupRow {
  provider: string;
  server: string;
  tool: string;
  calls: number | bigint;
  firstCallAt: string;
  lastCallAt: string;
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

const serverKey = (provider: string | undefined, server: string): string =>
  `${provider ?? ''}\u0000${server}`;

/**
 * Folds per-tool observed-call rows into their server breakdowns, busiest tool
 * first. The server's first/last call time is derived from its named tools, so a
 * server with no captured tool names keeps `tools: []` and null timestamps. Pure
 * so both read-side repos can share identical merge behaviour.
 */
export function attachMcpTools(
  servers: McpServerBreakdown[],
  toolRows: readonly McpToolRollupRow[],
): McpServerBreakdown[] {
  const byServer = new Map<string, McpToolBreakdown[]>();
  const firstByServer = new Map<string, string>();
  const lastByServer = new Map<string, string>();
  for (const row of toolRows) {
    const key = serverKey(row.provider, row.server);
    const tools = byServer.get(key) ?? [];
    tools.push({
      tool: row.tool,
      calls: Number(row.calls),
      firstCallAt: row.firstCallAt,
      lastCallAt: row.lastCallAt,
    });
    byServer.set(key, tools);
    const first = firstByServer.get(key);
    if (first === undefined || row.firstCallAt < first) firstByServer.set(key, row.firstCallAt);
    const last = lastByServer.get(key);
    if (last === undefined || row.lastCallAt > last) lastByServer.set(key, row.lastCallAt);
  }
  return servers.map((server) => {
    const key = serverKey(server.provider, server.server);
    return {
      ...server,
      tools: byServer.get(key) ?? [],
      firstCallAt: firstByServer.get(key) ?? null,
      lastCallAt: lastByServer.get(key) ?? null,
    };
  });
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

/**
 * Per-tool rollup over observed calls only (the proxy never sees tool names).
 * Observed rows are already deduplicated by call identity, so COUNT(*) is the
 * distinct call total. Unnamed calls are excluded so the breakdown lists only
 * real tools. Caller binds the observed filter args.
 */
export function mcpToolRollupSource(observedFilter: string): string {
  return `SELECT provider, server, tool, COUNT(*) AS calls,
      MIN(recorded_at) AS firstCallAt, MAX(recorded_at) AS lastCallAt
    FROM mcp_observed_calls
    WHERE (${observedFilter}) AND tool <> ''
    GROUP BY provider, server, tool
    ORDER BY provider, server, COUNT(*) DESC, tool`;
}
