/**
 * Pure logic for the Ctrl+K command palette: a small, deterministic fuzzy
 * matcher over a registry of commands. Kept free of React/DOM so it can be unit
 * tested to 100% and reused by the palette component and any future callers.
 */

/** A single invokable action shown in the command palette. */
export interface Command {
  /** Stable id (used as React key and for invocation). */
  id: string;
  /** The primary label shown to the user. */
  title: string;
  /** Optional group/section label (e.g. "Navigation", "Theme"). */
  section?: string;
  /** Extra terms that should match this command but aren't in the title. */
  keywords?: string[];
  /** Display-only shortcut hint (e.g. "Ctrl+,"); not parsed. */
  shortcut?: string;
}

/**
 * Scores how well `query` fuzzy-matches `text`. Returns `null` when `query` is
 * not a subsequence of `text`. Higher is better: consecutive matches and
 * word-boundary starts are rewarded so "pr" ranks "PR Review" above "Prepare".
 */
export function fuzzyScore(text: string, query: string): number | null {
  let score = 0;
  let streak = 0;
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti += 1) {
    if (text[ti] === query[qi]) {
      streak += 1;
      score += streak;
      if (ti === 0 || text[ti - 1] === ' ') {
        score += 5;
      }
      qi += 1;
    } else {
      streak = 0;
    }
  }
  return qi === query.length ? score : null;
}

/**
 * Filters and ranks `commands` for `query`. An empty/whitespace query returns
 * the commands unchanged (registry order). Otherwise only matches are returned,
 * sorted by descending score with a stable alphabetical tie-break on title.
 */
export function filterCommands<T extends Command>(
  commands: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return [...commands];
  }
  const scored: Array<{ command: T; score: number }> = [];
  for (const command of commands) {
    const haystack = [command.title, ...(command.keywords ?? [])]
      .join(' ')
      .toLowerCase();
    const score = fuzzyScore(haystack, q);
    if (score !== null) {
      scored.push({ command, score });
    }
  }
  scored.sort(
    (a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title),
  );
  return scored.map((entry) => entry.command);
}
