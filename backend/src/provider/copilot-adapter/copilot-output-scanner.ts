import type {
  SessionFileOp,
  SessionFileTool,
  SessionOutputScanner,
  SessionOutputScannerContext,
} from '../../session-files/session-files-contract.js';

/**
 * Parses file operations the Copilot CLI announces in its terminal output.
 *
 * The CLI prints an explicit line whenever it writes a file, e.g.
 *   `● Created  C:\Users\me\Downloads\new-file.md`
 *   `● Edit  Create ~\notes\todo.md`
 * We look for one of these action verbs immediately followed by an absolute (or
 * `~`-relative) path. Requiring the verb to sit right before the path keeps
 * prose that merely mentions a path from being mistaken for a file operation.
 * Agency reuses this scanner since it wraps the same Copilot CLI.
 */

/** Action verbs that mean a file was created, keyed lowercase. */
const CREATE_VERBS = new Set([
  'created',
  'create',
  'wrote',
  'writing',
  'added',
  'generated',
]);

/** Action verbs that mean an existing file was modified, keyed lowercase. */
const EDIT_VERBS = new Set([
  'edited',
  'edit',
  'editing',
  'updated',
  'update',
  'modified',
  'patched',
  'changed',
]);

const ALL_VERBS = [...CREATE_VERBS, ...EDIT_VERBS];

/**
 * verb (immediately) followed by a path token, tried in this order:
 *   - a quoted path (may contain spaces)
 *   - a drive-letter absolute path (`C:\…` / `C:/…`)
 *   - a UNC path (`\\server\…`)
 *   - a `~`-relative path
 *   - a POSIX absolute path (`/…`)
 *   - a *relative* path with at least one internal separator
 *     (`Product\Backend\docs\file.md`, `src/index.ts`) — the CLI prints the
 *     path relative to the session's cwd in its Edit/Create tool headers. The
 *     leading segment must be filename-like and the token must not contain `:`
 *     so URLs (`https://…`) and drive paths don't leak into this alternative.
 */
const OP_PATTERN = new RegExp(
  String.raw`\b(` +
    ALL_VERBS.join('|') +
    String.raw`)\b[\s:]+` +
    String.raw`("[^"]+"|[A-Za-z]:[\\/]\S+|\\\\\S+|~[\\/]\S+|/\S+|` +
    String.raw`[\w.][\w.\-]*[\\/][^\s"<>|?*:]+)`,
  'gi',
);

/** Strips ANSI/VT escape sequences so redraw codes don't corrupt matches. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Characters that can never appear inside a real file path but which the
 * interactive TUI can render directly against one: control codes, characters
 * illegal in Windows paths (`| " < > ? *`), and the box-drawing / block /
 * geometric glyphs (U+2500–U+25FF, e.g. `┃ │ ─ ● ▌`) the CLI uses to draw the
 * bordered "chip" around a path. The path token is cut at the first of these.
 */
// eslint-disable-next-line no-control-regex
const PATH_JUNK_PATTERN = /[\x00-\x1f|"<>?*\u2500-\u25ff]/;

/** Keep the line buffer bounded when output has no line terminators. */
const MAX_BUFFER = 64 * 1024;

function toolFor(verb: string): SessionFileTool {
  return CREATE_VERBS.has(verb.toLowerCase()) ? 'create' : 'edit';
}

function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(path);
}

/** Removes surrounding quotes and trailing sentence punctuation from a token. */
function cleanPath(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  // The TUI may draw the path inside a bordered chip whose box glyphs abut the
  // path with no whitespace, so the greedy path token swallows them. Cut at the
  // first character that cannot legitimately occur in a path.
  const junk = path.search(PATH_JUNK_PATTERN);
  if (junk >= 0) {
    path = path.slice(0, junk);
  }
  // Drop trailing punctuation the CLI may append after the path in prose.
  path = path.replace(/["'.,;:)\]}]+$/, '');
  return path;
}

/** Resolves a tool-printed path to an absolute path, or null if not resolvable. */
function resolvePath(raw: string, ctx: SessionOutputScannerContext): string | null {
  const cleaned = cleanPath(raw);
  if (cleaned.length === 0) {
    return null;
  }
  // The interactive TUI truncates over-long tool-header paths with a horizontal
  // ellipsis (…). Such a token is not a real path, so ignore it rather than
  // record a wrong, truncated one.
  if (cleaned.includes('\u2026')) {
    return null;
  }
  if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    const rest = cleaned.slice(1).replace(/^[\\/]/, '');
    return rest ? joinPath(ctx.home, rest) : ctx.home;
  }
  if (isAbsolute(cleaned)) {
    return cleaned;
  }
  if (ctx.cwd) {
    return joinPath(ctx.cwd, cleaned);
  }
  return null;
}

/** Joins two path fragments preserving the base's separator style. */
function joinPath(base: string, rest: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const trimmedBase = base.replace(/[\\/]+$/, '');
  const normalizedRest = rest.replace(/[\\/]+/g, sep);
  return `${trimmedBase}${sep}${normalizedRest}`;
}

/** Extracts every file op announced on a single (ANSI-stripped) line. */
function opsInLine(line: string, ctx: SessionOutputScannerContext): SessionFileOp[] {
  const ops: SessionFileOp[] = [];
  OP_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OP_PATTERN.exec(line)) !== null) {
    const path = resolvePath(match[2], ctx);
    if (path) {
      ops.push({ path, tool: toolFor(match[1]) });
    }
  }
  return ops;
}

/** Creates a Copilot terminal-output scanner bound to a resolution context. */
export function createCopilotOutputScanner(
  ctx: SessionOutputScannerContext,
): SessionOutputScanner {
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
      const ops: SessionFileOp[] = [];
      for (const segment of segments) {
        const line = segment.replace(ANSI_PATTERN, '');
        ops.push(...opsInLine(line, ctx));
      }
      return ops;
    },
  };
}
