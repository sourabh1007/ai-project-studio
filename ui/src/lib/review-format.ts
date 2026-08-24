/**
 * Pure helpers for presenting Review Board findings: turning the reviewer's
 * prose into scannable bullet points, and tracking the human "resolve / ignore"
 * decision layered over each finding.
 *
 * Kept free of React and IO so the UI coverage gate can exercise every branch;
 * the stateful shell (persistence, subscriptions) lives in the run store.
 */

/** A human decision about a finding: fixed/accepted, or deliberately dismissed. */
export type FindingResolution = 'resolved' | 'ignored';

/** findingId → the reviewer's decision. Absent means "open / needs attention". */
export type FindingResolutionMap = Record<string, FindingResolution>;

/**
 * Split a block of reviewer prose into short bullet points. Splits on sentence
 * boundaries while protecting the common `A → B → C` fallback arrows and
 * decimal/version dots from being treated as sentence ends. Semicolons also
 * start a new bullet so long, clause-heavy sentences break up sensibly. Returns
 * a single-item list for short text, and an empty list for blank input.
 */
export function splitIntoBullets(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  // Break after sentence punctuation followed by whitespace + a capital/opening,
  // and after semicolons. Protect decimals (e.g. 3.5) via the capital lookahead.
  // Trimming guarantees a non-empty trailing piece, so `parts` is never empty.
  return trimmed
    .split(/(?<=[.!?])\s+(?=[A-Z(])|;\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The reviewer's decision for a finding, or null when still open. */
export function resolutionOf(
  map: FindingResolutionMap,
  findingId: string,
): FindingResolution | null {
  return map[findingId] ?? null;
}

/** How many of the given findings are still open (no resolve/ignore decision). */
export function openFindingCount(
  map: FindingResolutionMap,
  findingIds: readonly string[],
): number {
  return findingIds.filter((id) => !map[id]).length;
}

/**
 * Return a new map with a finding's resolution set, or cleared when `resolution`
 * is null (re-opening it). Never mutates the input.
 */
export function withResolution(
  map: FindingResolutionMap,
  findingId: string,
  resolution: FindingResolution | null,
): FindingResolutionMap {
  const next = { ...map };
  if (resolution) next[findingId] = resolution;
  else delete next[findingId];
  return next;
}

/**
 * Parse a persisted resolution blob defensively — anything malformed is dropped
 * so a corrupt localStorage entry can never crash the board.
 */
export function parseResolutions(raw: unknown): FindingResolutionMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: FindingResolutionMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === 'resolved' || value === 'ignored') out[key] = value;
  }
  return out;
}
