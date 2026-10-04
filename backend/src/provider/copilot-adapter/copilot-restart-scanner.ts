import type {
  SessionRestartRequest,
  SessionRestartScanner,
} from '../provider-contract.js';

/**
 * Parses the CLI's own "this session needs to restart" announcements so the IDE
 * can relaunch the session in place instead of leaving the user to spot the
 * message and restart by hand. The canonical case is an MCP server being
 * reconfigured mid-session, where the CLI prints, e.g.
 *   `MCP server is modified, session needs to restart`
 * Agency reuses this scanner since it wraps the same Copilot CLI. The restart is
 * requested at most once per session — the TUI often repeats the line while it
 * waits — so the IDE performs exactly one relaunch per announcement.
 */

/** Strips ANSI/VT escape sequences so redraw codes don't corrupt matches. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Matches the CLI's restart request. The stable, wording-independent core is
 * "session needs to restart" (also "session needs restarting" / "session must
 * restart"); an optional leading clause such as "MCP server is modified," is
 * captured as the reason when present.
 */
const RESTART_PATTERN =
  /session\s+(?:needs?(?:\s+to)?|must)\s+(?:be\s+)?restart(?:ed|ing|s)?/i;

/** Pulls a short reason from a leading "<reason>, session needs to restart". */
const REASON_PATTERN = /^(.*?)[,:]\s*(?=session\s+)/i;

/** Keep the line buffer bounded when output has no line terminators. */
const MAX_BUFFER = 64 * 1024;

function restartInLine(line: string): SessionRestartRequest | null {
  const text = line.trim();
  if (!RESTART_PATTERN.test(text)) {
    return null;
  }
  const reasonMatch = REASON_PATTERN.exec(text);
  const reason = (reasonMatch?.[1] ?? '').trim().replace(/[.\s]+$/, '');
  return { reason };
}

/** Creates a Copilot terminal-output session-restart-request scanner. */
export function createCopilotRestartScanner(): SessionRestartScanner {
  let buffer = '';
  let requested = false;
  return {
    feed(chunk) {
      if (requested) {
        return [];
      }
      buffer += chunk;
      if (buffer.length > MAX_BUFFER) {
        buffer = buffer.slice(buffer.length - MAX_BUFFER);
      }
      const segments = buffer.split(/\r\n|\r|\n/);
      buffer = segments.pop() as string;
      for (const segment of segments) {
        const request = restartInLine(segment.replace(ANSI_PATTERN, ''));
        if (request) {
          requested = true;
          return [request];
        }
      }
      return [];
    },
  };
}
