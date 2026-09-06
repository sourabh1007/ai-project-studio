import type {
  ChangeGraphCategory,
  ChangeGraphNode,
  PrChangeKind,
  TestMethodExplanation,
} from './types.js';

/** Placeholders the backend writes for a file whose English is not yet produced. */
export const UNEXPLAINED_WHAT_IT_DOES = 'No description was produced for this file.';
export const UNEXPLAINED_WHAT_CHANGED = 'No change summary was produced.';

/** The change kinds shown in a category's legend, in display order. */
export const LEGEND_KINDS: PrChangeKind[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
];

/** A positioned rectangle used to compute the graph's content extent. */
export interface ExtentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The bounding extent of all graph content, never smaller than the base layout
 * size. Because dragged nodes/boxes carry offsets that can push them outside the
 * original layout box (in any direction), the SVG viewBox must grow to enclose
 * them — otherwise the diagram is clipped/truncated the moment a tile is dragged
 * past an edge. `minX`/`minY` can go negative (drag up/left); callers translate
 * the content by `pad - min` so nothing is ever cut off and scrollbars appear.
 */
export function contentExtent(
  baseW: number,
  baseH: number,
  rects: ExtentRect[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = 0;
  let minY = 0;
  let maxX = baseW;
  let maxY = baseH;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Whether a node still carries the build-time placeholders rather than a real,
 * on-demand English explanation. The deterministic graph writes placeholders for
 * every node; the plain-English description is fetched lazily when clicked.
 */
export function nodeNeedsExplanation(node: ChangeGraphNode): boolean {
  return (
    node.whatItDoes.trim().length === 0 ||
    node.whatItDoes === UNEXPLAINED_WHAT_IT_DOES ||
    node.whatChanged.trim().length === 0 ||
    node.whatChanged === UNEXPLAINED_WHAT_CHANGED
  );
}

/**
 * The syntactic-review findings for a node, normalised to a string list. Tolerates
 * legacy persisted reviews that stored a single prose string (split into lines)
 * so a graph produced before the list contract still renders as findings.
 */
export function reviewFindings(review: ChangeGraphNode['review']): string[] {
  const raw = Array.isArray(review)
    ? review
    : typeof review === 'string'
      ? (review as string).split('\n')
      : [];
  return raw
    .map((entry) => String(entry).replace(/^[-*\u2022]\s*/, '').trim())
    .filter((entry) => entry.length > 0);
}

/** Human label for a change kind, tuned for the code vs test legend. */
export function changeKindLabel(
  kind: PrChangeKind,
  category: ChangeGraphCategory,
): string {
  if (category === 'test') {
    if (kind === 'added') {
      return 'New test';
    }
    if (kind === 'deleted') {
      return 'Removed test';
    }
    return 'Updated test';
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Finds the per-method explanation whose name matches a diff segment's name. */
export function explanationForSegment(
  name: string | null,
  methods: TestMethodExplanation[],
): string | null {
  if (!name) {
    return null;
  }
  const target = name.trim().toLowerCase();
  const hit = methods.find((m) => {
    const candidate = m.name.trim().toLowerCase();
    return (
      candidate === target ||
      candidate.includes(target) ||
      target.includes(candidate)
    );
  });
  return hit?.whatChanged.trim() || null;
}
