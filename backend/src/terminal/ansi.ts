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

export interface AnsiParserState {
  mode: 'text' | 'escape' | 'intermediate' | 'csi' | 'string';
  osc: boolean;
  stringEscape: boolean;
}

export interface AnsiParser {
  write(char: string): boolean;
  atTextBoundary(): boolean;
  snapshot(): AnsiParserState;
}

export function createAnsiParser(initial?: AnsiParserState): AnsiParser {
  let state: AnsiParserState['mode'] = initial?.mode ?? 'text';
  let osc = initial?.osc ?? false;
  let stringEscape = initial?.stringEscape ?? false;
  return {
    write(char) {
      const code = char.charCodeAt(0);
      if (code === 0x18 || code === 0x1a) {
        state = 'text';
        stringEscape = false;
        return false;
      }
      if (state === 'string') {
        if (
          code === 0x9c ||
          (osc && code === 7) ||
          (stringEscape && char === '\\')
        ) {
          state = 'text';
          stringEscape = false;
        } else {
          stringEscape = code === 0x1b;
        }
        return false;
      }
      if (code === 0x1b) {
        state = 'escape';
        return false;
      }
      if (code === 0x9b) {
        state = 'csi';
        return false;
      }
      if (
        code === 0x9d ||
        code === 0x90 ||
        code === 0x98 ||
        code === 0x9e ||
        code === 0x9f
      ) {
        osc = code === 0x9d;
        stringEscape = false;
        state = 'string';
        return false;
      }
      if (code === 7 || code === 0x9c) return false;
      if (char === '\r' || char === '\n' || char === '\t') {
        return true;
      }
      if (state === 'escape') {
        if (char === '[') {
          state = 'csi';
        } else if (
          char === ']' ||
          char === 'P' ||
          char === 'X' ||
          char === '^' ||
          char === '_'
        ) {
          osc = char === ']';
          stringEscape = false;
          state = 'string';
        } else {
          state = code >= 0x20 && code <= 0x2f ? 'intermediate' : 'text';
        }
        return false;
      }
      if (state === 'intermediate') {
        if (code >= 0x30 && code <= 0x7e) state = 'text';
        return false;
      }
      if (state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) state = 'text';
        return false;
      }
      return true;
    },
    atTextBoundary() {
      return state === 'text';
    },
    snapshot() {
      return { mode: state, osc, stringEscape };
    },
  };
}

/**
 * Stateful transcript filter. Control strings are discarded as they arrive,
 * never buffered, so an unterminated OSC/DCS cannot grow retained parser state.
 */
export function createAnsiStripper(): (chunk: string) => string {
  const parser = createAnsiParser();
  return (chunk) => {
    let text = '';
    for (const char of chunk) {
      if (parser.write(char)) {
        text += char;
      }
    }
    return text;
  };
}
