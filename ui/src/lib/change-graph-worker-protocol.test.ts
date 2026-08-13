import { describe, it, expect } from 'vitest';
import { computeLayout, toResponse } from './change-graph-worker-protocol';
import {
  buildChangeGraphLayout,
  buildFocusedChangeGraphLayout,
} from './change-graph-layout.js';
import type {
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

const sample = step({
  projects: [{ id: 'p1', name: 'Api', path: null }],
  nodes: [
    node({ path: 'src/A.cs', projectId: 'p1' }),
    node({ path: 'src/B.cs', projectId: 'p1' }),
  ],
  edges: [{ from: 'src/A.cs', to: 'src/B.cs', calls: [] }],
});

describe('computeLayout', () => {
  it('routes a full request to buildChangeGraphLayout, converting collapsed to a Set', () => {
    const viaProtocol = computeLayout({
      id: 1,
      kind: 'full',
      step: sample,
      category: 'code',
      collapsed: ['p1'],
    });
    const direct = buildChangeGraphLayout(sample, 'code', {
      collapsed: new Set(['p1']),
    });
    expect(viaProtocol).toEqual(direct);
  });

  it('routes a focused request to buildFocusedChangeGraphLayout', () => {
    const viaProtocol = computeLayout({
      id: 2,
      kind: 'focused',
      step: sample,
      category: 'code',
      focusPath: 'src/A.cs',
    });
    const direct = buildFocusedChangeGraphLayout(sample, 'code', 'src/A.cs');
    expect(viaProtocol).toEqual(direct);
  });
});

describe('toResponse', () => {
  it('tags the computed layout with the request id', () => {
    const response = toResponse({
      id: 42,
      kind: 'full',
      step: sample,
      category: 'code',
      collapsed: [],
    });
    expect(response.id).toBe(42);
    expect(response.layout).toEqual(
      buildChangeGraphLayout(sample, 'code', { collapsed: new Set() }),
    );
  });
});
