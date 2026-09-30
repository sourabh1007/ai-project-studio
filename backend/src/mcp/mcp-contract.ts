/** Contracts for the provider-agnostic MCP server management module. */

export type McpOperation = 'add' | 'edit' | 'remove' | 'toggle' | 'tools' | 'toolToggle' | 'restart';
export interface McpCapability { supported: boolean; reason: string | null }
export type McpCapabilities = Record<McpOperation, McpCapability>;
export interface McpProviderInfo {
  id: string;
  label?: string;
  description?: string;
  kind?: 'cli' | 'app';
  capabilities?: McpCapabilities;
  documentationUrl?: string;
}

/**
 * One MCP server entry. Specs retain their native source shape (Agency boolean
 * built-ins are presented as enabled objects). Names may be opaque scoped action
 * IDs; displayName is the native name. Private app lifecycle credentials are hidden.
 */
export interface McpServerEntry {
  name: string;
  displayName?: string;
  /** Public catalog presentation metadata, never inserted into native configuration. */
  description?: string;
  commandPreview?: string;
  authState?: {
    state: 'unknown' | 'required' | 'expired' | 'ready';
    checkedAt: string | null;
    message: string;
  };
  source?: string;
  scope?: string;
  enabled?: boolean;
  /** Installed, publicly documented option; not a configured or connected server. */
  catalog?: boolean;
  providerLabel?: string;
  origin?: 'app' | 'agency-built-in' | 'custom';
  builtinName?: string;
  /** Native declarations for one logical built-in, not separate server instances. */
  configurationSources?: Array<{
    kind: 'resolved' | 'global';
    source: string;
    scope: string;
    spec: Record<string, unknown>;
    enabled?: boolean;
  }>;
  /** Resolved settings differ from the authored global declaration. */
  configurationConflict?: boolean;
  /** Explicit native connection/authentication attempt for unknown or observed-required state. */
  authentication?: McpCapability;
  capabilities?: McpCapabilities;
  spec: Record<string, unknown>;
  /** Tools discovered from the live MCP server, annotated with current config. */
  tools?: McpToolEntry[];
  /** Outcome of the latest best-effort tool discovery probe. */
  toolDiscovery?: McpToolDiscovery;
}

/** The MCP configuration currently seen for a provider. */
export interface ProviderMcpConfig {
  providerId: string;
  /** Primary source: an absolute config path or an explicit native config command. */
  configPath: string;
  /** Whether any represented source was successfully read (not CLI installation/connection state). */
  exists: boolean;
  servers: McpServerEntry[];
  notices?: string[];
  capabilities?: McpCapabilities;
}

/** Input to add or update a single MCP server entry (upsert by name). */
export interface McpServerInput {
  name: string;
  spec: Record<string, unknown>;
}

export interface McpCommandOptions {
  command: string;
  options: Array<{
    flag: string;
    description: string;
    valueHint?: string;
    choices?: string[];
  }>;
  examples: string[];
  cachedAt: string | null;
  stale: boolean;
  message?: string;
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

export type McpAuthObservation = NonNullable<McpServerEntry['authState']>;

/** Durable store for the last-known native auth observation per server fingerprint. */
export interface McpAuthObservationStore {
  load(): ReadonlyArray<{ key: string; state: McpAuthObservation }>;
  put(key: string, state: McpAuthObservation): void;
  delete(key: string): void;
}

export interface McpAuthenticationJob {
  id: string;
  serverName: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  message: string;
  authUrl: string | null;
  deviceCode: string | null;
  expiresAt: string;
  server?: McpServerEntry;
}

export interface McpToolInspector {
  inspect(input: {
    serverName: string;
    spec: Record<string, unknown>;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Internal progress for an explicitly retained native authentication process. */
    onProgress?: (output: readonly string[]) => void;
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
  message?: string;
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
