/** Contracts for the provider-agnostic MCP server management module. */

/**
 * One MCP server entry. The `spec` is the raw object stored under
 * `mcpServers[name]` in the provider's config file, round-tripped faithfully so
 * the IDE never imposes (or loses) a CLI-specific shape.
 */
export interface McpServerEntry {
  name: string;
  spec: Record<string, unknown>;
  /** Tools discovered from the live MCP server, annotated with current config. */
  tools?: McpToolEntry[];
  /** Outcome of the latest best-effort tool discovery probe. */
  toolDiscovery?: McpToolDiscovery;
}

/** The MCP configuration currently seen for a provider. */
export interface ProviderMcpConfig {
  providerId: string;
  /** Absolute path of the provider's MCP config file (discovered at runtime). */
  configPath: string;
  /** Whether that config file currently exists on disk. */
  exists: boolean;
  servers: McpServerEntry[];
}

/** Input to add or update a single MCP server entry (upsert by name). */
export interface McpServerInput {
  name: string;
  spec: Record<string, unknown>;
}

/** One tool exposed by an MCP server. */
export interface McpToolEntry {
  name: string;
  description: string | null;
  /** False when the provider config allow-list excludes this tool. */
  enabled: boolean;
}

export type McpToolDiscoveryStatus = 'ok' | 'failed' | 'skipped';

/** Details from a live MCP probe, including auth/device-code output if any. */
export interface McpToolDiscovery {
  status: McpToolDiscoveryStatus;
  message: string | null;
  output: string[];
  /** True when the probe failed because the server needs the user to sign in. */
  authRequired?: boolean;
  /** A login/device-code URL the server printed, when one was detected. */
  authUrl?: string | null;
}

export type McpServerConnectionStatus =
  | 'connected'
  | 'auth-required'
  | 'error'
  | 'disabled'
  | 'unsupported';

/**
 * Slim, live connection status for a single server, surfaced on the manager
 * cards without dumping the full tool list. Producing it still spawns the
 * server, so it is only requested per-card, on demand.
 */
export interface McpServerStatus {
  name: string;
  status: McpServerConnectionStatus;
  /** Number of tools the server advertised when connected. */
  toolCount: number;
  authRequired: boolean;
  authUrl: string | null;
  message: string | null;
  /**
   * When a live probe failed, the ordered self-heal steps that were attempted
   * (initial probe, retries, then a best-effort AI diagnosis) with each step's
   * outcome. Surfaced so the UI can explain, on click, exactly what was tried
   * before giving up. Absent when the server connected on the first probe.
   */
  healAttempts?: McpHealAttempt[];
}

/** The outcome of a single self-heal step attempted on a failing connection. */
export type McpHealOutcome = 'recovered' | 'failed' | 'info';

/** One recovery step attempted while self-healing a failed MCP connection. */
export interface McpHealAttempt {
  /** Human-readable description of the step, e.g. "Retried the connection". */
  action: string;
  /** Whether this step fixed the connection, failed, or is informational. */
  outcome: McpHealOutcome;
  /** Optional extra detail (error text, AI diagnosis, etc.). */
  detail: string | null;
}

export interface McpToolInspection extends McpToolDiscovery {
  tools: Array<Omit<McpToolEntry, 'enabled'>>;
}

export interface McpToolInspector {
  inspect(input: {
    serverName: string;
    spec: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<McpToolInspection>;
}

/** Input to enable or disable one discovered MCP tool. */
export interface McpToolToggleInput {
  serverName: string;
  toolName: string;
  enabled: boolean;
}

/** Result of applying an MCP operation to config and live sessions. */
export interface McpApplyResult {
  config: ProviderMcpConfig;
  server: McpServerEntry;
  liveReloadedSessions: number;
  liveReloadCommand: string | null;
}

/**
 * Parsed MCP config file. Only `mcpServers` is interpreted; any other top-level
 * keys are preserved verbatim on write so unrelated config is never dropped.
 */
export interface McpConfigDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Thin IO port over the provider's MCP config JSON file (edge adapter). */
export interface McpConfigFileStore {
  /** Reads/parses the JSON file; resolves null when it does not exist. */
  read(path: string): Promise<McpConfigDocument | null>;
  /** Writes the JSON file, creating parent directories as needed. */
  write(path: string, document: McpConfigDocument): Promise<void>;
}
