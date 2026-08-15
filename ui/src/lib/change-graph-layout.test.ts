import { describe, expect, it } from 'vitest';

import {
  basename,
  BOX_GAP,
  BOX_PAD,
  BOX_TITLE_H,
  buildFocusedChangeGraphLayout,
  buildChangeGraphLayout,
  clipEdgeBetween,
  COL_GAP,
  COLLAPSED_BOX_H,
  findNode,
  formatEdgeLabel,
  LABEL_CHAR_W,
  layerBoxes,
  NODE_GAP,
  NODE_H,
  NODE_LABEL_PAD,
  NODE_MIN_W,
  nodeCenter,
  TITLE_CHAR_W,
} from './change-graph-layout.js';
import type {
  ChangeGraphEdge,
  ChangeGraphNode,
  ChangeGraphStep,
} from './types.js';

function step(overrides: Partial<ChangeGraphStep>): ChangeGraphStep {
  return {
    status: 'ready',
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
    projects: [],
    nodes: [],
    edges: [],
    ...overrides,
  };
}

function node(
  overrides: Partial<ChangeGraphNode> & { path: string; projectId: string },
): ChangeGraphNode {
  return {
    module: 'App',
    category: 'code',
    kind: 'changed',
    changeKind: 'modified',
    diff: '',
    whatItDoes: 'x',
    whatChanged: 'y',
    review: ['z'],
    ...overrides,
  };
}

function edge(
  from: string,
  to: string,
  calls: ChangeGraphEdge['calls'] = [],
): ChangeGraphEdge {
  return { from, to, calls };
}

describe('basename', () => {
  it('returns the trailing segment for posix and windows paths', () => {
    expect(basename('src/lib/api.ts')).toBe('api.ts');
    expect(basename('src\\lib\\api.ts')).toBe('api.ts');
  });

  it('falls back to the raw string when there is no segment', () => {
    expect(basename('')).toBe('');
    expect(basename('/')).toBe('/');
  });
});

describe('nodeCenter', () => {
  it('returns the centre of a placed node cell', () => {
    expect(
      nodeCenter({
        path: 'a',
        projectId: 'p',
        label: 'a',
        kind: 'changed',
        x: 10,
        y: 20,
        width: NODE_MIN_W,
      }),
    ).toEqual({ x: 10 + NODE_MIN_W / 2, y: 20 + NODE_H / 2 });
  });
});

describe('formatEdgeLabel', () => {
  it('returns an empty string for missing or empty calls', () => {
    expect(formatEdgeLabel(undefined)).toBe('');
    expect(formatEdgeLabel([])).toBe('');
  });

  it('reads caller() → Symbol in the arrow direction', () => {
    expect(formatEdgeLabel([{ caller: 'Run', symbol: 'Builder' }])).toBe(
      'Run() → Builder',
    );
  });

  it('marks module-scope references as initialisation', () => {
    expect(formatEdgeLabel([{ caller: null, symbol: 'Builder' }])).toBe(
      'init Builder',
    );
    expect(formatEdgeLabel([{ caller: '  ', symbol: 'Builder' }])).toBe(
      'init Builder',
    );
  });

  it('dedupes and caps many callers and symbols with +N', () => {
    expect(
      formatEdgeLabel([
        { caller: 'Run', symbol: 'Builder' },
        { caller: 'Run', symbol: 'Builder' },
        { caller: 'Setup', symbol: 'Client' },
        { caller: 'Init', symbol: 'Client' },
      ]),
    ).toBe('Run() +2 → Builder +1');
  });

  it('falls back to callers when no symbol is present', () => {
    expect(formatEdgeLabel([{ caller: 'Run', symbol: '' }])).toBe('Run()');
  });

  it('returns an empty string when neither caller nor symbol is present', () => {
    expect(formatEdgeLabel([{ caller: null, symbol: '' }])).toBe('');
  });
});

describe('buildChangeGraphLayout', () => {
  it('groups the category into project boxes with placed nodes and an edge', () => {
    const built = step({
      projects: [
        { id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' },
      ],
      nodes: [
        node({ path: 'src/Service.cs', projectId: 'src/App.csproj' }),
        node({ path: 'src/Store.cs', projectId: 'src/App.csproj' }),
      ],
      edges: [edge('src/Service.cs', 'src/Store.cs')],
    });

    const layout = buildChangeGraphLayout(built, 'code');

    expect(layout.boxes).toHaveLength(1);
    expect(layout.boxes[0]).toMatchObject({
      id: 'src/App.csproj',
      name: 'App',
      count: 2,
      x: 0,
      y: 0,
    });
    expect(layout.nodes.map((n) => n.path)).toEqual([
      'src/Service.cs',
      'src/Store.cs',
    ]);
    // Two files => 2 columns, 1 row: nodes share a row inside the box.
    expect(layout.nodes[0]).toMatchObject({
      x: BOX_PAD,
      y: BOX_TITLE_H + BOX_PAD,
    });
    expect(layout.nodes[1].x).toBe(BOX_PAD + NODE_MIN_W + NODE_GAP);
    expect(layout.nodes[0].width).toBe(NODE_MIN_W);
    // Edges are clipped to the node borders (not centre-to-centre) so the arrow
    // sits in the gap between the boxes instead of over their labels.
    expect(layout.edges).toEqual([
      {
        from: 'src/Service.cs',
        to: 'src/Store.cs',
        calls: [],
        highlightsChanges: false,
        x1: layout.nodes[0].x + NODE_MIN_W,
        y1: layout.nodes[0].y + NODE_H / 2,
        x2: layout.nodes[1].x,
        y2: layout.nodes[1].y + NODE_H / 2,
      },
    ]);
    expect(layout.width).toBe(layout.boxes[0].width);
    expect(layout.height).toBe(layout.boxes[0].height);
  });

  it('places a node into a second grid row and names unknown projects by id', () => {
    // Three files => 2 columns, 2 rows; the third wraps to the next row.
    const built = step({
      nodes: [
        node({ path: 'a.cs', projectId: 'proj' }),
        node({ path: 'b.cs', projectId: 'proj' }),
        node({ path: 'c.cs', projectId: 'proj' }),
      ],
    });

    const layout = buildChangeGraphLayout(built, 'code');

    // No declared project => the box falls back to the raw project id.
    expect(layout.boxes[0].name).toBe('proj');
    const third = layout.nodes[2];
    expect(third.x).toBe(BOX_PAD);
    expect(third.y).toBe(BOX_TITLE_H + BOX_PAD + NODE_H + NODE_GAP);
  });

  it('stacks unrelated boxes into a single left column', () => {
    // Four boxes with no references between them all sit in layer 0, so they
    // form one vertical column instead of a scattered grid.
    const count = 4;
    const nodes: ChangeGraphNode[] = [];
    const projects = [];
    for (let i = 0; i < count; i += 1) {
      projects.push({ id: `p${i}`, name: `P${i}`, path: null });
      nodes.push(node({ path: `f${i}.cs`, projectId: `p${i}` }));
    }

    const layout = buildChangeGraphLayout(step({ projects, nodes }), 'code');

    const first = layout.boxes[0];
    // Single column: every box shares the same x and stacks downward.
    expect(layout.boxes[1].x).toBe(first.x);
    expect(layout.boxes[1].y).toBe(first.height + BOX_GAP);
    expect(layout.boxes[2].y).toBe((first.height + BOX_GAP) * 2);
    expect(layout.height).toBe(first.height * count + BOX_GAP * (count - 1));
  });

  it('flows referenced boxes left-to-right by dependency layer', () => {
    // A references B, B references C, so the modules fan out into three columns
    // in call order: A (layer 0) → B (layer 1) → C (layer 2).
    const projects = [
      { id: 'a', name: 'A', path: null },
      { id: 'b', name: 'B', path: null },
      { id: 'c', name: 'C', path: null },
    ];
    const nodes = [
      node({ path: 'a.cs', projectId: 'a' }),
      node({ path: 'b.cs', projectId: 'b' }),
      node({ path: 'c.cs', projectId: 'c' }),
    ];
    const edges: ChangeGraphEdge[] = [
      { from: 'a.cs', to: 'b.cs', calls: [] },
      { from: 'b.cs', to: 'c.cs', calls: [] },
    ];

    const layout = buildChangeGraphLayout(
      step({ projects, nodes, edges }),
      'code',
    );

    const box = (id: string) => layout.boxes.find((b) => b.id === id)!;
    // Each layer sits strictly to the right of the previous one.
    expect(box('a').x).toBeLessThan(box('b').x);
    expect(box('b').x).toBeLessThan(box('c').x);
    // Single box per column => all vertically centred on the same row.
    expect(box('a').y).toBe(box('b').y);
  });

  it('layers boxes by longest reference path and tolerates cycles', () => {
    // A clean chain a → b → c lays out as consecutive layers 0,1,2.
    const chain = layerBoxes(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    expect(chain.get('a')).toBe(0);
    expect(chain.get('b')).toBe(1);
    expect(chain.get('c')).toBe(2);

    // A cycle a → b → c → a still terminates with finite, bounded layers.
    const cyclic = layerBoxes(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    );
    for (const id of ['a', 'b', 'c']) {
      const value = cyclic.get(id)!;
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(3);
    }
  });

  it('ignores self-edges and unknown endpoints when layering', () => {
    const layers = layerBoxes(
      ['a', 'b'],
      [
        ['a', 'a'],
        ['a', 'missing'],
        ['a', 'b'],
      ],
    );
    expect(layers.get('a')).toBe(0);
    expect(layers.get('b')).toBe(1);
    expect(COL_GAP).toBeGreaterThan(0);
  });

  it('widens nodes to fit long file labels so text never overflows', () => {
    const path = 'src/SingleTenantComputeProcessRGEnforcer.cs';
    const label = basename(path);
    const layout = buildChangeGraphLayout(
      step({ nodes: [node({ path, projectId: 'p' })] }),
      'code',
    );
    const expectedWidth = Math.ceil(label.length * LABEL_CHAR_W) + NODE_LABEL_PAD;
    expect(expectedWidth).toBeGreaterThan(NODE_MIN_W);
    expect(layout.nodes[0].width).toBe(expectedWidth);
    // One column, so the box is exactly one node wide plus padding.
    expect(layout.boxes[0].width).toBe(expectedWidth + BOX_PAD * 2);
  });

  it('widens a box to fit a long project title', () => {
    const name = 'Microsoft.Azure.Cosmos.ComputeV2.RgServer.Core';
    const layout = buildChangeGraphLayout(
      step({
        projects: [{ id: 'proj', name, path: null }],
        nodes: [node({ path: 'a.cs', projectId: 'proj' })],
      }),
      'code',
    );
    const gridWidth = NODE_MIN_W + BOX_PAD * 2;
    const titleWidth = Math.ceil((name.length + 4) * TITLE_CHAR_W) + BOX_PAD * 2;
    expect(titleWidth).toBeGreaterThan(gridWidth);
    expect(layout.boxes[0].width).toBe(titleWidth);
  });

  it('restricts nodes and edges to the requested category', () => {
    const built = step({
      projects: [
        { id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' },
        { id: 'tests/T.csproj', name: 'T', path: 'tests/T.csproj' },
      ],
      nodes: [
        node({ path: 'src/Service.cs', projectId: 'src/App.csproj' }),
        node({
          path: 'tests/StoreTests.cs',
          projectId: 'tests/T.csproj',
          category: 'test',
        }),
      ],
      // An edge whose endpoints straddle categories is never placed.
      edges: [edge('src/Service.cs', 'tests/StoreTests.cs')],
    });

    const code = buildChangeGraphLayout(built, 'code');
    expect(code.nodes.map((n) => n.path)).toEqual(['src/Service.cs']);
    expect(code.edges).toEqual([]);

    const test = buildChangeGraphLayout(built, 'test');
    expect(test.nodes.map((n) => n.path)).toEqual(['tests/StoreTests.cs']);
    expect(test.edges).toEqual([]);
  });

  it('propagates each node kind so callers can be coloured', () => {
    const built = step({
      projects: [{ id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' }],
      nodes: [
        node({ path: 'src/Store.cs', projectId: 'src/App.csproj' }),
        node({
          path: 'src/Caller.cs',
          projectId: 'src/App.csproj',
          kind: 'boundary',
          changeKind: null,
        }),
      ],
    });

    const layout = buildChangeGraphLayout(built, 'code');
    const byPath = new Map(layout.nodes.map((n) => [n.path, n.kind]));
    expect(byPath.get('src/Store.cs')).toBe('changed');
    expect(byPath.get('src/Caller.cs')).toBe('boundary');
  });

  it('is empty when no changed file matches the category', () => {
    const layout = buildChangeGraphLayout(step({}), 'code');
    expect(layout).toEqual({
      boxes: [],
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
  });

  it('preserves edge calls and marks call-backed edges as change highlights', () => {
    const built = step({
      nodes: [
        node({ path: 'src/Service.cs', projectId: 'p' }),
        node({ path: 'src/Store.cs', projectId: 'p' }),
      ],
      edges: [
        edge('src/Service.cs', 'src/Store.cs', [
          { symbol: 'Store', caller: 'Run' },
        ]),
      ],
    });

    const layout = buildChangeGraphLayout(built, 'code');

    expect(layout.edges[0]).toMatchObject({
      calls: [{ symbol: 'Store', caller: 'Run' }],
      highlightsChanges: true,
    });
  });

  it('treats legacy edges without call data as unhighlighted references', () => {
    const built = step({
      nodes: [
        node({ path: 'src/Service.cs', projectId: 'p' }),
        node({ path: 'src/Store.cs', projectId: 'p' }),
      ],
      edges: [{ from: 'src/Service.cs', to: 'src/Store.cs' }],
    });

    const layout = buildChangeGraphLayout(built, 'code');

    expect(layout.edges[0]).toMatchObject({
      calls: [],
      highlightsChanges: false,
    });
  });

  it('collapses a listed project into a module tile with no file nodes', () => {
    const built = step({
      projects: [{ id: 'p', name: 'App', path: null }],
      nodes: [
        node({ path: 'a.cs', projectId: 'p' }),
        node({ path: 'b.cs', projectId: 'p' }),
        node({ path: 'c.cs', projectId: 'p' }),
      ],
    });

    const layout = buildChangeGraphLayout(built, 'code', {
      collapsed: new Set(['p']),
    });

    expect(layout.boxes).toHaveLength(1);
    expect(layout.boxes[0]).toMatchObject({ id: 'p', collapsed: true, count: 3 });
    // A collapsed box places none of its files.
    expect(layout.nodes).toEqual([]);
    expect(layout.boxes[0].height).toBe(COLLAPSED_BOX_H);
  });

  it('re-anchors edges to a collapsed module and hides its internal edges', () => {
    const built = step({
      projects: [
        { id: 'p1', name: 'One', path: null },
        { id: 'p2', name: 'Two', path: null },
      ],
      nodes: [
        node({ path: 'p1/a.cs', projectId: 'p1' }),
        node({ path: 'p1/b.cs', projectId: 'p1' }),
        node({ path: 'p1/c.cs', projectId: 'p1' }),
        node({ path: 'p2/x.cs', projectId: 'p2' }),
      ],
      edges: [
        // Internal to the collapsed module p1: dropped.
        edge('p1/a.cs', 'p1/b.cs'),
        // Crosses from collapsed p1 into expanded p2: re-anchored to the tile.
        edge('p1/a.cs', 'p2/x.cs', [{ symbol: 'X', caller: 'A' }]),
        // A parallel cross-module edge is merged into the same module edge.
        edge('p1/c.cs', 'p2/x.cs', [{ symbol: 'X', caller: 'C' }]),
      ],
    });

    const layout = buildChangeGraphLayout(built, 'code', {
      collapsed: new Set(['p1']),
    });

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({
      from: 'box:p1',
      to: 'p2/x.cs',
      highlightsChanges: true,
    });
    // Both parallel edges' calls are merged onto the single module edge.
    expect(layout.edges[0].calls).toEqual([
      { symbol: 'X', caller: 'A' },
      { symbol: 'X', caller: 'C' },
    ]);
  });

  it('promotes a merged module edge to highlighted when a later parallel edge has calls', () => {
    const built = step({
      projects: [
        { id: 'p1', name: 'One', path: null },
        { id: 'p2', name: 'Two', path: null },
      ],
      nodes: [
        node({ path: 'p1/a.cs', projectId: 'p1' }),
        node({ path: 'p1/b.cs', projectId: 'p1' }),
        node({ path: 'p1/c.cs', projectId: 'p1' }),
        node({ path: 'p2/x.cs', projectId: 'p2' }),
      ],
      edges: [
        // First cross-module edge carries no calls: the module edge starts
        // unhighlighted (highlightsChanges false).
        edge('p1/a.cs', 'p2/x.cs'),
        // A parallel edge with calls merges in and promotes the module edge.
        edge('p1/c.cs', 'p2/x.cs', [{ symbol: 'X', caller: 'C' }]),
      ],
    });

    const layout = buildChangeGraphLayout(built, 'code', {
      collapsed: new Set(['p1']),
    });

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({
      from: 'box:p1',
      to: 'p2/x.cs',
      highlightsChanges: true,
    });
    expect(layout.edges[0].calls).toEqual([{ symbol: 'X', caller: 'C' }]);
  });

  it('keeps every project expanded when no collapse set is given', () => {
    const built = step({
      nodes: [
        node({ path: 'a.cs', projectId: 'p' }),
        node({ path: 'b.cs', projectId: 'p' }),
        node({ path: 'c.cs', projectId: 'p' }),
      ],
    });

    const layout = buildChangeGraphLayout(built, 'code');

    expect(layout.boxes[0].collapsed).toBe(false);
    expect(layout.nodes).toHaveLength(3);
  });
});

describe('clipEdgeBetween', () => {
  it('clips a horizontal edge to the facing vertical borders', () => {
    const a = { x: 0, y: 0, halfW: 10, halfH: 5 };
    const b = { x: 100, y: 0, halfW: 20, halfH: 5 };
    expect(clipEdgeBetween(a, b)).toEqual({
      x1: 10,
      y1: 0,
      x2: 80,
      y2: 0,
    });
  });

  it('clips a vertical edge to the facing horizontal borders', () => {
    const a = { x: 0, y: 0, halfW: 10, halfH: 5 };
    const b = { x: 0, y: 100, halfW: 10, halfH: 8 };
    expect(clipEdgeBetween(a, b)).toEqual({
      x1: 0,
      y1: 5,
      x2: 0,
      y2: 92,
    });
  });

  it('clips a diagonal edge to whichever border it exits first', () => {
    // Square boxes offset diagonally: the ray exits through a corner-adjacent
    // border, scaled by the smaller of the x/y extents.
    const a = { x: 0, y: 0, halfW: 10, halfH: 10 };
    const b = { x: 40, y: 20, halfW: 10, halfH: 10 };
    const clipped = clipEdgeBetween(a, b);
    expect(clipped.x1).toBeCloseTo(10);
    expect(clipped.y1).toBeCloseTo(5);
    expect(clipped.x2).toBeCloseTo(30);
    expect(clipped.y2).toBeCloseTo(15);
  });

  it('falls back to the shared centre for concentric rectangles', () => {
    const a = { x: 5, y: 5, halfW: 10, halfH: 10 };
    const b = { x: 5, y: 5, halfW: 4, halfH: 4 };
    expect(clipEdgeBetween(a, b)).toEqual({ x1: 5, y1: 5, x2: 5, y2: 5 });
  });
});

describe('findNode', () => {
  it('finds a node by path and returns null when absent', () => {
    const built = step({
      nodes: [node({ path: 'src/Store.cs', projectId: 'p' })],
    });
    expect(findNode(built, 'src/Store.cs')?.path).toBe('src/Store.cs');
    expect(findNode(built, 'missing')).toBeNull();
  });
});

describe('buildFocusedChangeGraphLayout', () => {
  it('places callers on the left, the focused file in the middle and callees on the right', () => {
    const built = step({
      nodes: [
        node({ path: 'src/Caller.cs', projectId: 'p', kind: 'boundary' }),
        node({ path: 'src/Focus.cs', projectId: 'p' }),
        node({ path: 'src/Callee.cs', projectId: 'p' }),
        node({ path: 'src/Unrelated.cs', projectId: 'p' }),
      ],
      edges: [
        edge('src/Caller.cs', 'src/Focus.cs', [
          { symbol: 'Focus', caller: 'Run' },
        ]),
        edge('src/Focus.cs', 'src/Callee.cs', [
          { symbol: 'Callee', caller: 'Save' },
        ]),
        edge('src/Caller.cs', 'src/Callee.cs', [
          { symbol: 'Callee', caller: 'Ignored' },
        ]),
      ],
    });

    const layout = buildFocusedChangeGraphLayout(built, 'code', 'src/Focus.cs');
    const byPath = new Map(layout.nodes.map((n) => [n.path, n]));

    expect(layout.boxes).toEqual([]);
    expect(layout.nodes.map((n) => n.path)).toEqual([
      'src/Caller.cs',
      'src/Focus.cs',
      'src/Callee.cs',
    ]);
    expect(byPath.get('src/Caller.cs')?.x).toBeLessThan(
      byPath.get('src/Focus.cs')?.x ?? 0,
    );
    expect(byPath.get('src/Callee.cs')?.x).toBeGreaterThan(
      byPath.get('src/Focus.cs')?.x ?? Number.MAX_SAFE_INTEGER,
    );
    expect(layout.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      'src/Caller.cs->src/Focus.cs',
      'src/Focus.cs->src/Callee.cs',
    ]);
    expect(layout.edges[0]).toMatchObject({
      calls: [{ symbol: 'Focus', caller: 'Run' }],
      highlightsChanges: true,
    });
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('returns a single focused node when there are no incident edges', () => {
    const built = step({
      nodes: [node({ path: 'src/Focus.cs', projectId: 'p' })],
    });

    const layout = buildFocusedChangeGraphLayout(built, 'code', 'src/Focus.cs');

    expect(layout.nodes.map((n) => n.path)).toEqual(['src/Focus.cs']);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(layout.nodes[0].width);
    expect(layout.height).toBe(NODE_H);
  });

  it('returns an empty layout for a missing focus or category mismatch', () => {
    const built = step({
      nodes: [node({ path: 'src/Focus.cs', projectId: 'p', category: 'test' })],
    });

    expect(buildFocusedChangeGraphLayout(built, 'code', 'missing')).toEqual({
      boxes: [],
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
    expect(buildFocusedChangeGraphLayout(built, 'code', 'src/Focus.cs')).toEqual({
      boxes: [],
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
  });

  it('places bidirectional neighbours once on the outgoing side and draws both edges', () => {
    const built = step({
      nodes: [
        node({ path: 'src/Focus.cs', projectId: 'p' }),
        node({ path: 'src/Peer.cs', projectId: 'p' }),
      ],
      edges: [
        edge('src/Peer.cs', 'src/Focus.cs'),
        edge('src/Focus.cs', 'src/Peer.cs'),
      ],
    });

    const layout = buildFocusedChangeGraphLayout(built, 'code', 'src/Focus.cs');

    expect(layout.nodes.map((n) => n.path)).toEqual([
      'src/Focus.cs',
      'src/Peer.cs',
    ]);
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.every((edge) => edge.highlightsChanges)).toBe(false);
  });
});
