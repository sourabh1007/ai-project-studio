import type { McpConfigDocument } from './mcp-contract.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts the names of the MCP servers the CLI would load from a parsed
 * `mcp-config.json` document — i.e. every object-valued `mcpServers` entry that
 * is not explicitly disabled (`enabled: false`). Used to build the per-session
 * `--disable-mcp-server` flags that keep headless meta sessions from triggering
 * MCP browser/OAuth sign-ins on load. Returns an empty list for a missing or
 * malformed document.
 */
export function enabledMcpServerNames(
  document: McpConfigDocument | null,
): string[] {
  const servers = document?.mcpServers;
  if (!isPlainObject(servers)) {
    return [];
  }
  return Object.entries(servers)
    .filter(
      ([, spec]) => isPlainObject(spec) && spec.enabled !== false,
    )
    .map(([name]) => name);
}
