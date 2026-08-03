/** Contracts for the provider-agnostic MCP server management module. */

/**
 * One MCP server entry. The `spec` is the raw object stored under
 * `mcpServers[name]` in the provider's config file, round-tripped faithfully so
 * the IDE never imposes (or loses) a CLI-specific shape.
 */
export interface McpServerEntry {
  name: string;
  spec: Record<string, unknown>;
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
