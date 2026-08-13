/**
 * Pure, DOM-free universal search index — the ranking engine behind the
 * first-class search / universal command bar (Ctrl+K). It indexes heterogeneous
 * workspace entities (files, classes, methods, sessions, graph nodes, designs,
 * PRs, agents, AI results) behind one uniform shape and ranks them for a query.
 *
 * Kept free of React/DOM so it can be unit tested to 100% and reused by the
 * palette component, the graph focus integration, and any future caller.
 */

import { fuzzyScore } from '../command-palette.js';

/** The kinds of things that can appear in universal search. */
export type SearchKind =
  | 'file'
  | 'class'
  | 'method'
  | 'session'
  | 'node'
  | 'design'
  | 'pr'
  | 'agent'
  | 'ai';

/** A single searchable entity, normalised across every source. */
export interface SearchEntry {
  /** Stable id, unique within its kind (used as React key / for navigation). */
  id: string;
  /** What this entry represents; drives icon, grouping and routing. */
  kind: SearchKind;
  /** Primary label shown to the user. */
  title: string;
  /** Optional secondary line (e.g. a path, repo, or file for a method). */
  subtitle?: string;
  /** Extra terms that should match but aren't in the title/subtitle. */
  keywords?: string[];
}

/** A ranked search hit: the matched entry plus its score (higher is better). */
export interface SearchHit {
  entry: SearchEntry;
  score: number;
}

/**
 * Per-kind ranking bias so that, at equal fuzzy score, more actionable results
 * surface first. Files and symbols are what developers jump to most, so they
 * outrank ambient AI results. Absent kinds contribute no bias.
 */
const KIND_WEIGHT: Record<SearchKind, number> = {
  file: 6,
  class: 5,
  method: 5,
  node: 4,
  session: 3,
  pr: 3,
  agent: 2,
  design: 2,
  ai: 1,
};

/** The searchable text for an entry: title + subtitle + keywords, lowercased. */
function haystack(entry: SearchEntry): string {
  return [entry.title, entry.subtitle ?? '', ...(entry.keywords ?? [])]
    .join(' ')
    .toLowerCase();
}

/**
 * Ranks `entries` for `query`. An empty/whitespace query returns every entry in
 * registry order (no scoring). Otherwise only fuzzy matches are returned, sorted
 * by descending combined score (fuzzy score + kind weight), with a stable
 * alphabetical tie-break on title. `limit`, when given and positive, caps the
 * number of hits returned.
 */
export function searchEntries(
  entries: readonly SearchEntry[],
  query: string,
  limit?: number,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  let hits: SearchHit[];
  if (q.length === 0) {
    hits = entries.map((entry) => ({ entry, score: 0 }));
  } else {
    hits = [];
    for (const entry of entries) {
      const score = fuzzyScore(haystack(entry), q);
      if (score !== null) {
        hits.push({ entry, score: score + KIND_WEIGHT[entry.kind] });
      }
    }
    hits.sort(
      (a, b) =>
        b.score - a.score || a.entry.title.localeCompare(b.entry.title),
    );
  }
  return limit !== undefined && limit > 0 ? hits.slice(0, limit) : hits;
}

/** Groups hits by kind, preserving the ranked order within each group. */
export function groupHitsByKind(
  hits: readonly SearchHit[],
): Array<{ kind: SearchKind; hits: SearchHit[] }> {
  const order: SearchKind[] = [];
  const buckets = new Map<SearchKind, SearchHit[]>();
  for (const hit of hits) {
    const bucket = buckets.get(hit.entry.kind);
    if (bucket === undefined) {
      buckets.set(hit.entry.kind, [hit]);
      order.push(hit.entry.kind);
    } else {
      bucket.push(hit);
    }
  }
  return order.map((kind) => ({ kind, hits: buckets.get(kind) as SearchHit[] }));
}
