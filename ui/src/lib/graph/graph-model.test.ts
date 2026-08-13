import { describe, expect, it } from 'vitest';
import {
  buildGraphModel,
  relationshipCounts,
  tiersForLevel,
  visibleEdges,
  visibleNodes,
  zoomLevelForScale,
  ZOOM_DETAIL_THRESHOLD,
  ZOOM_MID_THRESHOLD,
  type GraphInputEdge,
  type GraphInputNode,
} from './graph-model.js';

const nodes: GraphInputNode[] = [
  { id: 'svc', tier: 'group', label: 'Service' },
  { id: 'cls', tier: 'type', label: 'Class', groupId: 'svc' },
  { id: 'm1', tier: 'member', label: 'method', groupId: 'cls' },
];
const edges: GraphInputEdge[] = [
  { id: 'e1', source: 'svc', target: 'cls' },
  { id: 'e2', source: 'cls', target: 'm1' },
];

describe('zoomLevelForScale', () => {
  it('shows only groups when zoomed out', () => {
    expect(zoomLevelForScale(0)).toBe('overview');
    expect(zoomLevelForScale(ZOOM_MID_THRESHOLD - 0.01)).toBe('overview');
  });

  it('shows types at mid zoom', () => {
    expect(zoomLevelForScale(ZOOM_MID_THRESHOLD)).toBe('mid');
    expect(zoomLevelForScale(ZOOM_DETAIL_THRESHOLD - 0.01)).toBe('mid');
  });

  it('shows members at detail zoom', () => {
    expect(zoomLevelForScale(ZOOM_DETAIL_THRESHOLD)).toBe('detail');
    expect(zoomLevelForScale(3)).toBe('detail');
  });
});

describe('buildGraphModel', () => {
  it('keeps the first of duplicate node ids', () => {
    const model = buildGraphModel(
      [
        { id: 'a', tier: 'group', label: 'first' },
        { id: 'a', tier: 'type', label: 'second' },
      ],
      [],
    );
    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0].label).toBe('first');
  });

  it('drops edges with a missing endpoint', () => {
    const model = buildGraphModel(nodes, [
      { id: 'ok', source: 'svc', target: 'cls' },
      { id: 'bad-src', source: 'ghost', target: 'cls' },
      { id: 'bad-tgt', source: 'svc', target: 'ghost' },
    ]);
    expect(model.edges.map((e) => e.id)).toEqual(['ok']);
  });
});

describe('tiersForLevel', () => {
  it('cumulatively reveals tiers', () => {
    expect([...tiersForLevel('overview')]).toEqual(['group']);
    expect([...tiersForLevel('mid')]).toEqual(['group', 'type']);
    expect([...tiersForLevel('detail')]).toEqual(['group', 'type', 'member']);
  });
});

describe('visibleNodes / visibleEdges (progressive disclosure)', () => {
  const model = buildGraphModel(nodes, edges);

  it('overview shows only the group node and no edges into hidden nodes', () => {
    expect(visibleNodes(model, 'overview').map((n) => n.id)).toEqual(['svc']);
    expect(visibleEdges(model, 'overview')).toEqual([]);
  });

  it('mid shows groups + types and the edge between them', () => {
    expect(visibleNodes(model, 'mid').map((n) => n.id)).toEqual(['svc', 'cls']);
    expect(visibleEdges(model, 'mid').map((e) => e.id)).toEqual(['e1']);
  });

  it('detail shows everything', () => {
    expect(visibleNodes(model, 'detail')).toHaveLength(3);
    expect(visibleEdges(model, 'detail').map((e) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('relationshipCounts', () => {
  it('counts in + out degree per node', () => {
    const counts = relationshipCounts(buildGraphModel(nodes, edges));
    expect(counts.get('svc')).toBe(1);
    expect(counts.get('cls')).toBe(2);
    expect(counts.get('m1')).toBe(1);
  });

  it('is empty for an edgeless graph', () => {
    expect(relationshipCounts(buildGraphModel(nodes, [])).size).toBe(0);
  });
});
