import type { ModelChangeScanner } from '../provider-contract.js';

/**
 * Parses mid-session model switches the Copilot CLI announces in its terminal
 * output. The interactive TUI prints an explicit status line whenever the
 * active model changes, e.g.
 *   `● Model changed from auto to claude-opus-4.8 (medium)`
 *   `● Model changed to gpt-5.4`
 * We capture the model id after the final ` to ` and drop any trailing effort
 * parenthetical or punctuation. Agency reuses this scanner since it wraps the
 * same Copilot CLI. Reporting the switch lets the UI's per-session model label
 * track the CLI immediately, instead of waiting for the next usage row.
 */

/** Strips ANSI/VT escape sequences so redraw codes don't corrupt matches. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * `Model changed [from <old>] to <model>` — the model token is the run of
 * non-space, non-parenthesis characters after the final ` to `, so a trailing
 * ` (medium)` effort marker is excluded. Lazy so a model id containing no `to`
 * matches the announcement's own ` to `, not any later prose.
 */
const MODEL_CHANGE_PATTERN = /\bmodel changed\b.*?\bto\s+([^\s()]+)/i;

/**
 * Characters that can never appear inside a real model id but which the TUI can
 * render directly against one: control codes, the horizontal ellipsis used for
 * truncation, and the box-drawing/geometric glyphs (U+2500–U+25FF) the CLI uses
 * to draw its status chrome. The token is cut at the first of these.
 */
// eslint-disable-next-line no-control-regex
const TOKEN_JUNK_PATTERN = /[\x00-\x1f\u2026\u2500-\u25ff]/;

/** Keep the line buffer bounded when output has no line terminators. */
const MAX_BUFFER = 64 * 1024;

/** Extracts a newly-selected model id from a single (ANSI-stripped) line. */
function modelInLine(line: string): string | null {
  const match = MODEL_CHANGE_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  let token = match[1];
  const junk = token.search(TOKEN_JUNK_PATTERN);
  if (junk >= 0) {
    token = token.slice(0, junk);
  }
  token = token.replace(/["'.,;:]+$/, '');
  return token.length > 0 ? token : null;
}

/** Creates a Copilot terminal-output model-change scanner. */
export function createCopilotModelScanner(): ModelChangeScanner {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER) {
        buffer = buffer.slice(buffer.length - MAX_BUFFER);
      }
      // Split on any line terminator, including bare CRs used for TUI redraws.
      const segments = buffer.split(/\r\n|\r|\n/);
      // `split` always yields at least one element, so `pop` never returns
      // undefined; the last (possibly empty) segment is the unterminated tail.
      buffer = segments.pop() as string;
      const models: string[] = [];
      for (const segment of segments) {
        const model = modelInLine(segment.replace(ANSI_PATTERN, ''));
        if (model) {
          models.push(model);
        }
      }
      return models;
    },
  };
}
