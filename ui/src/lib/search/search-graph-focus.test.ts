import { describe, expect, it } from 'vitest';
import {
  applyFocus,
  focusFromHit,
  focusFromHits,
  type GraphFocus,
} from './search-graph-focus.js';
import type { RfGraph } from '../graph/react-flow-adapter.js';
import type { SearchHit, SearchKind } from './search-index.js';

describe('focusFromHit', () => {
  it('targets graph-backed search kinds', () => {
    expect(focusFromHit(hit('class-a', 'class'))).toEqual({
      focusNodeId: 'class-a',
      highlightIds: new Set(['class-a']),
    });
    expect(focusFromHit(hit('method-a', 'method')).highlightIds).toEqual(
      new Set(['method-a']),
    );
    expect(focusFromHit(hit('node-a', 'node')).focusNodeId).toBe('node-a');
  });

  it('ignores search kinds that do not map to graph nodes', () => {
    expect(focusFromHit(hit('file-a', 'file'))).toEqual({
      focusNodeId: null,
      highlightIds: new Set(),
    });
  });
});

describe('focusFromHits', () => {
  it('uses the first ranked graph hit as focus and highlights every graph hit', () => {
    const focus = focusFromHits([
      hit('file-a', 'file'),
      hit('method-a', 'method'),
      hit('class-a', 'class'),
      hit('node-a', 'node'),
      hit('session-a', 'session'),
    ]);

    expect(focus.focusNodeId).toBe('method-a');
    expect(focus.highlightIds).toEqual(
      new Set(['method-a', 'class-a', 'node-a']),
    );
  });

  it('returns empty focus when no hits target graph nodes', () => {
    expect(focusFromHits([hit('file-a', 'file'), hit('agent-a', 'agent')])).toEqual(
      {
        focusNodeId: null,
        highlightIds: new Set(),
      },
    );
  });
});

describe('applyFocus', () => {
  const graph: RfGraph = {
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, data: nodeData('A') },
      { id: 'b', position: { x: 1, y: 0 }, data: nodeData('B') },
      { id: 'c', position: { x: 2, y: 0 }, data: nodeData('C') },
    ],
    edges: [
      { id: 'a-b', source: 'a', target: 'b', data: edgeData() },
      { id: 'b-c', source: 'b', target: 'c', data: edgeData() },
      { id: 'c-a', source: 'c', target: 'a', data: edgeData() },
    ],
  };

  it('returns a neutral graph when focus has no highlights', () => {
    const focused = applyFocus(graph, {
      focusNodeId: null,
      highlightIds: new Set(),
    });

    expect(focused).not.toBe(graph);
    expect(focused.nodes[0]).not.toBe(graph.nodes[0]);
    expect(focused.nodes.map((node) => node.data)).toEqual([
      nodeData('A'),
      nodeData('B'),
      nodeData('C'),
    ]);
    expect(focused.edges.map((edge) => edge.data)).toEqual([
      edgeData(),
      edgeData(),
      edgeData(),
    ]);
  });

  it('highlights matching nodes, dims unrelated nodes, and preserves edge context', () => {
    const focused = applyFocus(graph, graphFocus(['a', 'b']));

    expect(Object.fromEntries(focused.nodes.map((node) => [node.id, node.data]))).toMatchObject({
      a: { highlighted: true, dimmed: false },
      b: { highlighted: true, dimmed: false },
      c: { highlighted: false, dimmed: true },
    });
    expect(Object.fromEntries(focused.edges.map((edge) => [edge.id, edge.data]))).toEqual({
      'a-b': { highlighted: true, dimmed: false },
      'b-c': { highlighted: false, dimmed: false },
      'c-a': { highlighted: false, dimmed: false },
    });
  });

  it('dims edges whose endpoints are both outside the highlight set', () => {
    const focused = applyFocus(graph, graphFocus(['a']));

    expect(Object.fromEntries(focused.edges.map((edge) => [edge.id, edge.data]))).toEqual({
      'a-b': { highlighted: false, dimmed: false },
      'b-c': { highlighted: false, dimmed: true },
      'c-a': { highlighted: false, dimmed: false },
    });
  });
});

function hit(id: string, kind: SearchKind): SearchHit {
  return {
    entry: { id, kind, title: id },
    score: 1,
  };
}

function graphFocus(ids: string[]): GraphFocus {
  return {
    focusNodeId: ids[0] ?? null,
    highlightIds: new Set(ids),
  };
}

function nodeData(label: string): RfGraph['nodes'][number]['data'] {
  return {
    label,
    tier: 'type',
    relationships: 0,
    highlighted: false,
    dimmed: false,
  };
}

function edgeData(): RfGraph['edges'][number]['data'] {
  return { highlighted: false, dimmed: false };
}
