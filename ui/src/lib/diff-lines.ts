/**
 * Selectable right-side (new file) lines extracted from a unified diff, so a
 * reviewer can anchor an inline comment to a concrete line the PR touched. Only
 * added (`+`) and context (` `) lines exist on the new side; removed (`-`) lines
 * do not and are skipped. Hunk headers (`@@ -a,b +c,d @@`) reset the running
 * new-side line counter.
 */
export interface DiffRightLine {
  /** 1-based line number on the new (right) side of the diff. */
  line: number;
  /** Whether the PR added this line or it is unchanged context. */
  kind: 'added' | 'context';
  /** The line's text, without the leading diff marker. */
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified diff into the list of right-side lines a comment can anchor
 * to. Returns an empty list for an empty diff or one with no hunks. Lines before
 * the first hunk header (file headers like `diff --git`, `+++`, `---`) are
 * ignored.
 */
export function rightSideLines(diff: string): DiffRightLine[] {
  const result: DiffRightLine[] = [];
  if (!diff) {
    return result;
  }
  let current = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      current = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    // Diff-level file markers can appear mid-stream in multi-file patches.
    if (raw.startsWith('+++') || raw.startsWith('---')) {
      continue;
    }
    if (raw.startsWith('+')) {
      result.push({ line: current, kind: 'added', text: raw.slice(1) });
      current += 1;
    } else if (raw.startsWith('-')) {
      // Removed line: consumes no new-side line number.
      continue;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — not a real line.
      continue;
    } else {
      // Context line (leading space) or a blank line within the hunk.
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      result.push({ line: current, kind: 'context', text });
      current += 1;
    }
  }
  return result;
}

/** The visual class of a rendered diff line, for colour-coding the display. */
export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/** One rendered diff line, annotated for display and inline commenting. */
export interface DiffDisplayLine {
  /** The raw diff line text, including its leading marker. */
  raw: string;
  /** Colour-coding class for the line. */
  kind: DiffLineKind;
  /**
   * The 1-based new-side line number a comment can anchor to, or `null` for
   * lines that carry no new-side position (removed lines, hunk headers, file
   * markers, "no newline" markers, and any text before the first hunk).
   */
  rightLine: number | null;
}

/**
 * Annotates every line of a unified diff for rendering: its colour class and,
 * where the line exists on the new side, the line number a review comment can
 * anchor to. This keeps the diff view declarative and lets a reviewer click any
 * commentable line to comment in place, mirroring {@link rightSideLines} for the
 * anchor numbers while preserving one entry per displayed line.
 */
export function annotateDiffLines(diff: string): DiffDisplayLine[] {
  const trimmed = diff.replace(/\n$/, '');
  if (trimmed.length === 0) {
    return [];
  }
  const result: DiffDisplayLine[] = [];
  let current = 0;
  let inHunk = false;
  for (const raw of trimmed.split('\n')) {
    if (raw.startsWith('@@')) {
      const header = HUNK_HEADER.exec(raw);
      if (header) {
        current = Number(header[1]);
      }
      inHunk = true;
      result.push({ raw, kind: 'hunk', rightLine: null });
      continue;
    }
    if (
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('+++') ||
      raw.startsWith('---')
    ) {
      result.push({ raw, kind: 'meta', rightLine: null });
      continue;
    }
    if (!inHunk) {
      result.push({ raw, kind: 'ctx', rightLine: null });
      continue;
    }
    if (raw.startsWith('+')) {
      result.push({ raw, kind: 'add', rightLine: current });
      current += 1;
    } else if (raw.startsWith('-')) {
      result.push({ raw, kind: 'del', rightLine: null });
    } else if (raw.startsWith('\\')) {
      result.push({ raw, kind: 'ctx', rightLine: null });
    } else {
      result.push({ raw, kind: 'ctx', rightLine: current });
      current += 1;
    }
  }
  return result;
}
