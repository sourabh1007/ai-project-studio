import { describe, expect, it } from 'vitest';
import { layeredLayout } from './layered-layout.js';
import type { GraphInputEdge, GraphInputNode } from './graph-model.js';

const n = (id: string): GraphInputNode => ({ id, tier: 'type', label: id });

describe('layeredLayout', () => {
  it('returns a zero-size canvas for an empty graph', () => {
    const result = layeredLayout([], []);
    expect(result.nodes).toEqual([]);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it('places a chain in successive layers by dependency depth', () => {
    const nodes = [n('a'), n('b'), n('c')];
    const edges: GraphInputEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const result = layeredLayout(nodes, edges);
    const layers = Object.fromEntries(
      result.nodes.map((node) => [node.id, node.layer]),
    );
    expect(layers).toEqual({ a: 0, b: 1, c: 2 });
    // x increases with layer; a is at the origin column.
    expect(result.nodes.find((node) => node.id === 'a')?.x).toBe(0);
    expect(result.nodes.find((node) => node.id === 'c')?.x).toBeGreaterThan(0);
  });

  it('stacks nodes within the same layer without overlapping', () => {
    const nodes = [n('a'), n('b')];
    const result = layeredLayout(nodes, [], {
      nodeHeight: 40,
      rowGap: 10,
    });
    const ys = result.nodes.map((node) => node.y);
    expect(ys).toEqual([0, 50]);
  });

  it('uses longest-path layering when a node has multiple predecessors', () => {
    // a -> c, a -> b -> c : c must sit after b (layer 2), not layer 1.
    const nodes = [n('a'), n('b'), n('c')];
    const edges: GraphInputEdge[] = [
      { id: 'e1', source: 'a', target: 'c' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'c' },
    ];
    const layer = Object.fromEntries(
      layeredLayout(nodes, edges).nodes.map((node) => [node.id, node.layer]),
    );
    expect(layer.c).toBe(2);
  });

  it('terminates and stays bounded on a cycle', () => {
    const nodes = [n('a'), n('b')];
    const edges: GraphInputEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ];
    const result = layeredLayout(nodes, edges);
    // Every node still placed; layers remain within the node-count bound.
    expect(result.nodes).toHaveLength(2);
    for (const node of result.nodes) {
      expect(node.layer).toBeLessThanOrEqual(nodes.length);
    }
  });

  it('ignores edges referencing unknown nodes', () => {
    const result = layeredLayout([n('a')], [
      { id: 'e', source: 'a', target: 'ghost' },
    ]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].layer).toBe(0);
  });

  it('honours custom sizing options for canvas bounds', () => {
    const result = layeredLayout([n('a'), n('b')], [
      { id: 'e', source: 'a', target: 'b' },
    ], { nodeWidth: 100, layerGap: 50, nodeHeight: 30, rowGap: 5 });
    // two layers: width = 1*(100+50) + 100 = 250; single row tall = 30.
    expect(result.width).toBe(250);
    expect(result.height).toBe(30);
  });
});
