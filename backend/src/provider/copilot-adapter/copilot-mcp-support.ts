import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpSupport } from '../provider-contract.js';

/** The Copilot CLI reads MCP servers from a JSON file with this basename. */
export const COPILOT_MCP_CONFIG_FILENAME = 'mcp-config.json';

const DISCOVERY_PROMPT = [
  'Output only the absolute filesystem path to your MCP server configuration',
  `file (${COPILOT_MCP_CONFIG_FILENAME}) on this machine.`,
  'Respond with just the path on a single line and no other text.',
].join(' ');

/**
 * Extracts a `mcp-config.json` path from a CLI reply. Matches the last
 * whitespace-free token ending in the config filename (handling both POSIX and
 * Windows separators) and strips wrapping quotes/backticks the CLI may add.
 */
export function parseCopilotMcpConfigPath(reply: string): string | null {
  const matches = reply.match(/\S*mcp-config\.json/gi);
  if (!matches || matches.length === 0) {
    return null;
  }
  const candidate = matches[matches.length - 1]
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .trim();
  // The match always contains the literal filename, so after trimming wrapping
  // quotes a non-empty path remains.
  return candidate;
}

/**
 * MCP support for the Copilot CLI. Agency wraps the same CLI, so it reuses this
 * rather than duplicating the discovery prompt/parsing (mirroring how the
 * output and model scanners are shared).
 */
export function createCopilotMcpSupport(): McpSupport {
  return {
    configPathPrompt: DISCOVERY_PROMPT,
    parseConfigPath: parseCopilotMcpConfigPath,
    defaultConfigPath: () => join(homedir(), '.copilot', COPILOT_MCP_CONFIG_FILENAME),
    liveReloadCommand: '/restart',
  };
}
