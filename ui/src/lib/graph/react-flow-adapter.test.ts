import { describe, expect, it } from 'vitest';
import { buildGraphModel, type GraphInputNode } from './graph-model.js';
import { layeredLayout, type LayoutResult } from './layered-layout.js';
import {
  filterByRelationship,
  toReactFlow,
  type RfGraph,
} from './react-flow-adapter.js';

const nodes: GraphInputNode[] = [
  { id: 'group', tier: 'group', label: 'Group' },
  { id: 'type-a', tier: 'type', label: 'Type A', groupId: 'group' },
  { id: 'type-b', tier: 'type', label: 'Type B', groupId: 'group' },
  { id: 'member', tier: 'member', label: 'Member', groupId: 'type-a' },
  { id: 'solo', tier: 'group', label: 'Solo' },
];

const model = buildGraphModel(nodes, [
  { id: 'group-type-a', source: 'group', target: 'type-a' },
  { id: 'type-a-type-b', source: 'type-a', target: 'type-b' },
  { id: 'type-a-member', source: 'type-a', target: 'member' },
  { id: 'group-type-b', source: 'group', target: 'type-b' },
]);

describe('toReactFlow', () => {
  it('keeps only nodes that are both visible and placed, then drops dangling edges', () => {
    const layout = layeredLayout(nodes, model.edges).nodes.filter(
      (node) => node.id !== 'type-b',
    );
    const graph = toReactFlow(
      model,
      { nodes: layout, width: 0, height: 0 },
      'mid',
    );

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'group',
      'type-a',
      'solo',
    ]);
    expect(graph.edges.map((edge) => edge.id)).toEqual(['group-type-a']);
    expect(graph.nodes.find((node) => node.id === 'group')?.position).toEqual({
      x: 0,
      y: 0,
    });
    expect(graph.nodes.find((node) => node.id === 'solo')?.data.relationships).toBe(
      0,
    );
  });

  it('wires model labels, tiers, relationship counts, and neutral flags', () => {
    const layout = layeredLayout(nodes, model.edges);
    const graph = toReactFlow(model, layout, 'detail');

    expect(graph.nodes.find((node) => node.id === 'type-a')?.data).toEqual({
      label: 'Type A',
      tier: 'type',
      relationships: 3,
      highlighted: false,
      dimmed: false,
    });
    expect(
      graph.edges.every((edge) => !edge.data.highlighted && !edge.data.dimmed),
    ).toBe(true);
  });

  it('treats an empty highlight set the same as absent highlights', () => {
    const layout = layeredLayout(nodes, model.edges);
    const graph = toReactFlow(model, layout, 'mid', {
      highlightIds: new Set<string>(),
    });

    expect(
      graph.nodes.every((node) => !node.data.highlighted && !node.data.dimmed),
    ).toBe(true);
    expect(
      graph.edges.every((edge) => !edge.data.highlighted && !edge.data.dimmed),
    ).toBe(true);
  });

  it('highlights and dims nodes and edges from a populated highlight set', () => {
    const layout: LayoutResult = {
      nodes: [
        { id: 'group', x: 0, y: 0, width: 160, height: 44, layer: 0 },
        { id: 'type-a', x: 240, y: 0, width: 160, height: 44, layer: 1 },
        { id: 'type-b', x: 240, y: 64, width: 160, height: 44, layer: 1 },
        { id: 'solo', x: 0, y: 64, width: 160, height: 44, layer: 0 },
      ],
      width: 400,
      height: 108,
    };
    const graph = toReactFlow(model, layout, 'mid', {
      highlightIds: new Set(['group', 'type-a']),
    });

    expect(
      Object.fromEntries(graph.nodes.map((node) => [node.id, node.data])),
    ).toMatchObject({
      group: { highlighted: true, dimmed: false },
      'type-a': { highlighted: true, dimmed: false },
      'type-b': { highlighted: false, dimmed: true },
      solo: { highlighted: false, dimmed: true },
    });
    expect(
      Object.fromEntries(graph.edges.map((edge) => [edge.id, edge.data])),
    ).toEqual({
      'group-type-a': { highlighted: true, dimmed: false },
      'type-a-type-b': { highlighted: false, dimmed: false },
      'group-type-b': { highlighted: false, dimmed: false },
    });
  });

  it('dims edges whose endpoints are both outside the highlight set', () => {
    const layout = layeredLayout(nodes, model.edges);
    const graph = toReactFlow(model, layout, 'mid', {
      highlightIds: new Set(['solo']),
    });

    expect(
      Object.fromEntries(graph.edges.map((edge) => [edge.id, edge.data])),
    ).toEqual({
      'group-type-a': { highlighted: false, dimmed: true },
      'type-a-type-b': { highlighted: false, dimmed: true },
      'group-type-b': { highlighted: false, dimmed: true },
    });
  });
});

describe('filterByRelationship', () => {
  const graph: RfGraph = {
    nodes: [
      { id: 'root', position: { x: 0, y: 0 }, data: nodeData('Root') },
      { id: 'in', position: { x: -1, y: 0 }, data: nodeData('Inbound') },
      { id: 'out', position: { x: 1, y: 0 }, data: nodeData('Outbound') },
      { id: 'other', position: { x: 2, y: 0 }, data: nodeData('Other') },
    ],
    edges: [
      { id: 'in-root', source: 'in', target: 'root', data: edgeData() },
      { id: 'root-out', source: 'root', target: 'out', data: edgeData() },
      { id: 'out-other', source: 'out', target: 'other', data: edgeData() },
    ],
  };

  it('keeps the root, direct neighbours, and only root-incident edges', () => {
    expect(filterByRelationship(graph, 'root')).toEqual({
      nodes: graph.nodes.slice(0, 3),
      edges: graph.edges.slice(0, 2),
    });
  });

  it('returns an empty graph when the root is absent', () => {
    expect(filterByRelationship(graph, 'missing')).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

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
