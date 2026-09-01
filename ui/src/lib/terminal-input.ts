/**
 * xterm answers a full-screen TUI's color-palette queries (OSC 4 for the 16
 * ANSI colors, OSC 10/11/12 for fg/bg/cursor) by emitting the reply back
 * through the SAME `onData` channel used for keystrokes — so the reply is sent
 * to the CLI's stdin. Some CLIs (the Copilot TUI included) don't consume that
 * reply as an escape sequence; they insert its printable body
 * (`4;0;rgb:2e2e/3434/3636…`) straight into their input line, mixing garbage
 * into whatever the user is typing. Repeated queries (e.g. on resize) make it
 * happen again and again.
 *
 * Strip those color-report replies from the outbound data before it reaches the
 * PTY. This targets only OSC 4/10/11/12 reports — cursor-position and
 * device-attribute answers (CSI sequences the TUI genuinely needs for layout)
 * are left untouched, and real keystrokes never contain a raw OSC report, so
 * nothing the user actually types is affected.
 */

// OSC (ESC ]) 4 | 10 | 11 | 12, any body up to a BEL or ST (ESC \) terminator.
// The body of a color report never contains ESC except the ST that ends it, so
// excluding ESC/BEL from the body keeps each match bounded to a single report.
const COLOR_REPORT = /\x1b\](?:4|1[0-2]);[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Removes OSC color-query replies from data xterm is about to send to the PTY. */
export function stripTerminalColorReports(data: string): string {
  if (!data.includes('\x1b]')) {
    return data;
  }
  return data.replace(COLOR_REPORT, '');
}

/**
 * OSC identifiers whose *query* form makes xterm emit a reply the hosted CLI
 * mis-parses: 4 (indexed ANSI palette), 10 (foreground), 11 (background),
 * 12 (cursor).
 */
export const COLOR_QUERY_OSC_IDENTS = [4, 10, 11, 12] as const;

/**
 * True when an OSC 4/10/11/12 payload is a color *query* (contains `?`) rather
 * than a *set* (`rgb:…`/`#rrggbb`). Registering an OSC handler that returns this
 * lets us suppress xterm's auto-reply at the source for queries — so the reply
 * is never generated, regardless of onData chunking/timing — while still
 * letting the CLI *set* palette colors (return false → xterm's default runs).
 */
export function isColorQuery(payload: string): boolean {
  return payload.includes('?');
}
