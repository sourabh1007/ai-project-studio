/**
 * Pure, dependency-free adapter from the reusable graph engine into
 * React-Flow-shaped data. It deliberately returns plain structural objects,
 * not `@xyflow/react` types, so the future canvas can adopt React Flow without
 * coupling the graph model, layout, or tests to that dependency.
 */

import type { LayoutResult } from './layered-layout.js';
import {
  relationshipCounts,
  visibleEdges,
  visibleNodes,
  type GraphModel,
  type NodeTier,
  type ZoomLevel,
} from './graph-model.js';

/** Plain node shape matching the subset the future React Flow canvas needs. */
export interface RfNode {
  id: string;
  position: { x: number; y: number };
  data: {
    label: string;
    tier: NodeTier;
    relationships: number;
    highlighted: boolean;
    dimmed: boolean;
  };
}

/** Plain edge shape matching the subset the future React Flow canvas needs. */
export interface RfEdge {
  id: string;
  source: string;
  target: string;
  data: {
    highlighted: boolean;
    dimmed: boolean;
  };
}

/** A render-ready graph expressed as plain React-Flow-shaped nodes and edges. */
export interface RfGraph {
  nodes: RfNode[];
  edges: RfEdge[];
}

/**
 * Converts a filtered `GraphModel` plus a concrete layout into plain
 * React-Flow-shaped data. Nodes must be both visible at `level` and present in
 * `layout`; edges are kept only when both endpoints survived that node pass.
 * Highlighting is intentionally structural: absent/empty highlights leave every
 * node and edge neutral, while a populated set highlights matching nodes and
 * edges whose endpoints are both highlighted.
 */
export function toReactFlow(
  model: GraphModel,
  layout: LayoutResult,
  level: ZoomLevel,
  options?: { highlightIds?: ReadonlySet<string> },
): RfGraph {
  const placedById = new Map(layout.nodes.map((node) => [node.id, node]));
  const counts = relationshipCounts(model);
  const highlightIds = options?.highlightIds;
  const hasHighlights = highlightIds !== undefined && highlightIds.size > 0;

  const nodes: RfNode[] = [];
  for (const node of visibleNodes(model, level)) {
    const placed = placedById.get(node.id);
    if (placed === undefined) {
      continue;
    }
    const highlighted = hasHighlights && highlightIds.has(node.id);
    nodes.push({
      id: node.id,
      position: { x: placed.x, y: placed.y },
      data: {
        label: node.label,
        tier: node.tier,
        relationships: counts.get(node.id) ?? 0,
        highlighted,
        dimmed: hasHighlights && !highlighted,
      },
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: RfEdge[] = visibleEdges(model, level)
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => {
      const sourceHighlighted = hasHighlights && highlightIds.has(edge.source);
      const targetHighlighted = hasHighlights && highlightIds.has(edge.target);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        data: {
          highlighted: sourceHighlighted && targetHighlighted,
          dimmed: hasHighlights && !sourceHighlighted && !targetHighlighted,
        },
      };
    });

  return { nodes, edges };
}

/**
 * Narrows an adapted graph to `rootId`, its direct neighbours, and only the
 * edges incident to the root. If the root is not present in the graph, an empty
 * graph is returned so callers never render a dangling relationship view.
 */
export function filterByRelationship(graph: RfGraph, rootId: string): RfGraph {
  if (!graph.nodes.some((node) => node.id === rootId)) {
    return { nodes: [], edges: [] };
  }

  const edges = graph.edges.filter(
    (edge) => edge.source === rootId || edge.target === rootId,
  );
  const nodeIds = new Set<string>([rootId]);
  for (const edge of edges) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }

  return {
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges,
  };
}
