/** Write-side contracts for proxy-measured MCP server I/O usage. */

/**
 * One measured slice of a single MCP server's transport I/O, reported by the
 * launch proxy that wraps the server. A slice is flushed when the wrapped
 * server process exits (or on a periodic flush), so a long-lived server can
 * contribute several rows over its lifetime. All counts are real, observed
 * values — never estimated.
 */
export interface McpServerUsageRecord {
  /** Feature the driving CLI session belongs to; the attribution key. */
  featureId: string;
  /** Driving CLI session id, when the proxy could resolve one. */
  sessionId: string | null;
  /** Provider whose MCP config launched the server (e.g. `copilot`). */
  provider: string;
  /** MCP server name, exactly as configured under `mcpServers`. */
  server: string;
  /** `tools/call` JSON-RPC requests routed to the server in this slice. */
  calls: number;
  /** Bytes written to the server's stdin (requests). */
  inputBytes: number;
  /** Bytes read from the server's stdout (responses/notifications). */
  outputBytes: number;
  /** Summed wall-clock time attributed to the server's tool calls, ms. */
  durationMs: number;
  /** ISO timestamp the slice was recorded. */
  recordedAt: string;
}

/** Persistence port for proxy-measured MCP usage slices. */
export interface McpUsageRepo {
  /** Appends one measured slice. */
  record(entry: McpServerUsageRecord): void;
  /** Removes every slice for a feature (feature-deletion cleanup). */
  deleteByFeature(featureId: string): void;
  /** Removes every slice for a session (session-deletion cleanup). */
  deleteBySession(sessionId: string): void;
}
