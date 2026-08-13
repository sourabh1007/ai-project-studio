/**
 * Pure, dependency-free layered graph layout — a deterministic fallback layout
 * for the reusable graph engine that needs no Dagre/ELK and so can be unit
 * tested to 100%. Dagre/ELK can replace it later behind the same
 * `LayoutResult` shape; until then this gives the engine a working, cycle-safe
 * layered placement (left → right by dependency depth).
 */

import type { GraphInputEdge, GraphInputNode } from './graph-model.js';

/** A node placed in absolute canvas coordinates. */
export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Zero-based dependency depth (column index). */
  layer: number;
}

/** The output of a layout pass: placed nodes and the overall canvas size. */
export interface LayoutResult {
  nodes: PlacedNode[];
  width: number;
  height: number;
}

/** Tunable spacing for the layered layout; compact defaults suit dense graphs. */
export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  /** Horizontal gap between layers (columns). */
  layerGap?: number;
  /** Vertical gap between nodes within a layer. */
  rowGap?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  nodeWidth: 160,
  nodeHeight: 44,
  layerGap: 80,
  rowGap: 20,
};

/**
 * Assigns each node a layer index using longest-path layering over a
 * cycle-broken graph. Back-edges (edges pointing to an ancestor still on the DFS
 * stack) are ignored so layering is well-defined and every layer stays within
 * `[0, nodes.length)`. Within the resulting DAG, a node's layer is one greater
 * than the maximum layer of its forward predecessors.
 */
function assignLayers(
  nodes: readonly GraphInputNode[],
  edges: readonly GraphInputEdge[],
): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      (outgoing.get(edge.source) as string[]).push(edge.target);
    }
  }

  // DFS to classify edges; drop back-edges (target currently on the stack).
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on-stack, 2 done
  const forward: Array<[string, string]> = [];
  const visit = (start: string): void => {
    // Iterative DFS so deep graphs don't overflow the call stack.
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = outgoing.get(frame.id) as string[];
      if (frame.next < neighbours.length) {
        const target = neighbours[frame.next];
        frame.next += 1;
        const targetState = state.get(target) ?? 0;
        if (targetState === 1) {
          continue; // back-edge into an ancestor: skip for layering
        }
        forward.push([frame.id, target]);
        if (targetState === 0) {
          state.set(target, 1);
          stack.push({ id: target, next: 0 });
        }
      } else {
        state.set(frame.id, 2);
        stack.pop();
      }
    }
  };
  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) {
      visit(node.id);
    }
  }

  const layer = new Map<string, number>();
  for (const node of nodes) {
    layer.set(node.id, 0);
  }
  // Relax forward edges to a fixpoint; the DAG guarantees termination in < N passes.
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const [source, target] of forward) {
      const from = layer.get(source) as number;
      const to = layer.get(target) as number;
      if (to < from + 1) {
        layer.set(target, from + 1);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return layer;
}

/**
 * Places `nodes` in left-to-right layers by dependency depth. Within a layer,
 * nodes keep their input order and are stacked top-to-bottom. Returns placed
 * nodes plus the tight canvas bounds. An empty graph yields a zero-size canvas.
 */
export function layeredLayout(
  nodes: readonly GraphInputNode[],
  edges: readonly GraphInputEdge[],
  options: LayoutOptions = {},
): LayoutResult {
  const opts = { ...DEFAULTS, ...options };
  const layer = assignLayers(nodes, edges);
  // Row counter per layer so nodes stack without overlapping.
  const rowInLayer = new Map<number, number>();
  const placed: PlacedNode[] = [];
  let maxLayer = 0;
  let maxRow = 0;

  for (const node of nodes) {
    const l = layer.get(node.id) as number;
    const row = rowInLayer.get(l) ?? 0;
    rowInLayer.set(l, row + 1);
    maxLayer = Math.max(maxLayer, l);
    maxRow = Math.max(maxRow, row + 1);
    placed.push({
      id: node.id,
      layer: l,
      x: l * (opts.nodeWidth + opts.layerGap),
      y: row * (opts.nodeHeight + opts.rowGap),
      width: opts.nodeWidth,
      height: opts.nodeHeight,
    });
  }

  const width =
    placed.length === 0
      ? 0
      : maxLayer * (opts.nodeWidth + opts.layerGap) + opts.nodeWidth;
  const height =
    placed.length === 0
      ? 0
      : maxRow * opts.nodeHeight + (maxRow - 1) * opts.rowGap;

  return { nodes: placed, width, height };
}
