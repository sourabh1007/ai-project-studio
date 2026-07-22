/**
 * Strips ANSI escape sequences (colours, cursor moves, TUI control codes) from
 * a chunk of terminal output so it can be stored as a readable transcript and
 * fed to the AI summarizer. Kept pure and dependency-free for easy testing.
 */

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|[\u0007]|[\u001b][()][AB012]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}
