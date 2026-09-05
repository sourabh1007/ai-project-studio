import type { McpErrorScanner, McpServerError } from '../provider-contract.js';

/**
 * Parses MCP server connection failures the Copilot CLI announces in its
 * terminal output. When a configured MCP server can't be initialized the TUI
 * prints, e.g.
 *   `! Failed to connect to MCP server "Azure": failed to initialize MCP
 *      client: connection closed: initialize response.`
 * We capture the server name (quoted or bare) and the trailing reason so the
 * IDE can surface a single out-of-band notice per server instead of the error
 * only scrolling past in the session. Agency reuses this scanner since it wraps
 * the same Copilot CLI. Each server is reported at most once per session — the
 * CLI often repeats the line on retries.
 */

/** Strips ANSI/VT escape sequences so redraw codes don't corrupt matches. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * `Failed to connect to MCP server "<name>"[: <reason>]`. The name is either a
 * double-quoted run or a bare non-space token, so both `"Azure"` and `Azure`
 * are captured. An optional trailing reason after the first `:` is kept and
 * trimmed of terminal chrome.
 */
const MCP_FAIL_PATTERN =
  /failed to connect to mcp server\s+(?:"([^"]+)"|(\S+?))\s*(?::\s*(.*))?$/i;

/** Box-drawing / control glyphs the TUI can render against the reason text. */
// eslint-disable-next-line no-control-regex
const REASON_JUNK_PATTERN = /[\x00-\x1f\u2500-\u25ff]/;

/** Keep the line buffer bounded when output has no line terminators. */
const MAX_BUFFER = 64 * 1024;

function errorInLine(line: string): McpServerError | null {
  const match = MCP_FAIL_PATTERN.exec(line.trim());
  if (!match) {
    return null;
  }
  // Exactly one of the two capture groups matches (quoted or bare name).
  const server = (match[1] ?? match[2])!.trim();
  if (server.length === 0) {
    return null;
  }
  let reason = (match[3] ?? '').trim();
  const junk = reason.search(REASON_JUNK_PATTERN);
  if (junk >= 0) {
    reason = reason.slice(0, junk).trim();
  }
  reason = reason.replace(/[.\s]+$/, '');
  return { server, reason };
}

/** Creates a Copilot terminal-output MCP-connection-error scanner. */
export function createCopilotMcpScanner(): McpErrorScanner {
  let buffer = '';
  const seen = new Set<string>();
  return {
    feed(chunk) {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER) {
        buffer = buffer.slice(buffer.length - MAX_BUFFER);
      }
      const segments = buffer.split(/\r\n|\r|\n/);
      buffer = segments.pop() as string;
      const errors: McpServerError[] = [];
      for (const segment of segments) {
        const error = errorInLine(segment.replace(ANSI_PATTERN, ''));
        if (error && !seen.has(error.server)) {
          seen.add(error.server);
          errors.push(error);
        }
      }
      return errors;
    },
  };
}
