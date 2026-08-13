/**
 * Pure bridge from universal search hits to graph focus state. Search stays
 * model-agnostic while graph callers get the exact focus/highlight intent they
 * need to make matching nodes feel instant.
 */

import type { RfGraph } from '../graph/react-flow-adapter.js';
import type { SearchHit, SearchKind } from './search-index.js';

/** Graph focus intent derived from one or more ranked search hits. */
export interface GraphFocus {
  /** The first graph node to center/filter around, if any hit targets a node. */
  focusNodeId: string | null;
  /** Every graph node id that should be visually highlighted. */
  highlightIds: ReadonlySet<string>;
}

const GRAPH_SEARCH_KINDS = new Set<SearchKind>(['class', 'method', 'node']);

/** Converts a single search hit into graph focus, ignoring non-graph hits. */
export function focusFromHit(hit: SearchHit): GraphFocus {
  if (!GRAPH_SEARCH_KINDS.has(hit.entry.kind)) {
    return { focusNodeId: null, highlightIds: new Set<string>() };
  }
  return {
    focusNodeId: hit.entry.id,
    highlightIds: new Set<string>([hit.entry.id]),
  };
}

/**
 * Converts ranked hits into one graph focus: the first graph hit becomes the
 * focus target, while every graph hit contributes to the highlight set.
 */
export function focusFromHits(hits: readonly SearchHit[]): GraphFocus {
  let focusNodeId: string | null = null;
  const highlightIds = new Set<string>();

  for (const hit of hits) {
    if (!GRAPH_SEARCH_KINDS.has(hit.entry.kind)) {
      continue;
    }
    if (focusNodeId === null) {
      focusNodeId = hit.entry.id;
    }
    highlightIds.add(hit.entry.id);
  }

  return { focusNodeId, highlightIds };
}

/**
 * Applies focus highlights to an already-adapted graph. A non-empty highlight
 * set highlights matching nodes and fully matching edges, dims unrelated nodes
 * and edges, and leaves partially related edges neutral for context.
 */
export function applyFocus(graph: RfGraph, focus: GraphFocus): RfGraph {
  const hasHighlights = focus.highlightIds.size > 0;
  return {
    nodes: graph.nodes.map((node) => {
      const highlighted = hasHighlights && focus.highlightIds.has(node.id);
      return {
        ...node,
        data: {
          ...node.data,
          highlighted,
          dimmed: hasHighlights && !highlighted,
        },
      };
    }),
    edges: graph.edges.map((edge) => {
      const sourceHighlighted =
        hasHighlights && focus.highlightIds.has(edge.source);
      const targetHighlighted =
        hasHighlights && focus.highlightIds.has(edge.target);
      return {
        ...edge,
        data: {
          ...edge.data,
          highlighted: sourceHighlighted && targetHighlighted,
          dimmed: hasHighlights && !sourceHighlighted && !targetHighlighted,
        },
      };
    }),
  };
}
