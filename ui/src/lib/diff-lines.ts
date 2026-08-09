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
