/**
 * Pure text helpers for the Planner's quick-add input: lightweight autocorrect,
 * title auto-formatting, and history-based autosuggestions. All functions are
 * deterministic and side-effect free so they stay fully unit-testable.
 */

/** Common quick-typing fixes applied word-by-word, case-insensitively. */
const AUTOCORRECT: Record<string, string> = {
  teh: 'the',
  recieve: 'receive',
  seperate: 'separate',
  occured: 'occurred',
  untill: 'until',
  wich: 'which',
  adn: 'and',
  nad: 'and',
  taht: 'that',
  fro: 'for',
  fix: 'fix',
  pr: 'PR',
  prs: 'PRs',
  ui: 'UI',
  api: 'API',
  ci: 'CI',
  db: 'DB',
  id: 'ID',
};

/** Restores the original casing pattern of `original` onto `replacement`. */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Fixes common typos and normalizes known acronyms. Unknown words are left as
 * typed. Internal spacing is collapsed but leading/trailing space is preserved
 * so the caller can keep correcting mid-typing without losing a trailing space.
 */
export function autocorrect(text: string): string {
  const leading = text.slice(0, text.length - text.trimStart().length);
  const trailing = text.slice(text.trimEnd().length);
  const words = text.trim().split(/\s+/).filter(Boolean);
  const fixed = words.map((word) => {
    const match = /^([^\p{L}]*)(\p{L}+)([^\p{L}]*)$/u.exec(word);
    if (!match) {
      return word;
    }
    const [, pre, core, post] = match;
    const replacement = AUTOCORRECT[core.toLowerCase()];
    if (!replacement) {
      return word;
    }
    return `${pre}${matchCase(core, replacement)}${post}`;
  });
  return `${leading}${fixed.join(' ')}${trailing}`;
}

/**
 * Formats a title on Add: trims, collapses whitespace, strips a trailing
 * sentence period, and capitalizes the first letter. Empty input stays empty.
 */
export function autoformatTitle(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (!collapsed) {
    return '';
  }
  const noTrailingDot = collapsed.replace(/\.+$/, '');
  return noTrailingDot.charAt(0).toUpperCase() + noTrailingDot.slice(1);
}

/**
 * Suggests up to `limit` previously used titles that start with the current
 * query (case-insensitive), most-recent first and de-duplicated. An empty or
 * whitespace-only query yields no suggestions.
 */
export function suggestTitles(
  query: string,
  history: readonly string[],
  limit = 5,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of history) {
    const title = entry.trim();
    const key = title.toLowerCase();
    if (!title || key === needle || seen.has(key)) {
      continue;
    }
    if (key.startsWith(needle)) {
      seen.add(key);
      out.push(title);
      if (out.length >= limit) {
        break;
      }
    }
  }
  return out;
}
