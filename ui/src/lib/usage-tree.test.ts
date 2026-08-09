import { describe, expect, it } from 'vitest';
import { buildUsageTree } from './usage-tree.js';
import type { GroupInfo, SessionBreakdown } from './types.js';

function session(
  sessionId: string,
  groupId: string | null,
  origin: SessionBreakdown['origin'],
  nanoAiu: number,
  inputTokens = 10,
  outputTokens = 5,
  activeMs = 1000,
): SessionBreakdown {
  return {
    sessionId,
    groupId,
    origin,
    provider: 'github-copilot',
    kind: origin === 'ide' ? 'meta' : 'dev',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    activeMs,
    sessions: 1,
    inputTokens,
    outputTokens,
    reasoningOutputTokens: 2,
    cost: 0.1,
    credits: 0.2,
    nanoAiu,
  };
}

describe('buildUsageTree', () => {
  it('returns an empty feature root for empty input', () => {
    expect(buildUsageTree([], [])).toEqual({
      type: 'feature',
      id: 'feature',
      name: 'Feature',
      totals: {
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        cost: 0,
        credits: 0,
        nanoAiu: 0,
        activeMs: 0,
      },
      children: [],
    });
  });

  it('nests groups at arbitrary depth and rolls totals up to ancestors', () => {
    const groups: GroupInfo[] = [
      { id: 'backend', name: 'Backend', kind: 'subcategory', parentGroupId: null },
      { id: 'api', name: 'API', kind: 'subcategory', parentGroupId: 'backend' },
      { id: 'routes', name: 'Routes', kind: 'subcategory', parentGroupId: 'api' },
    ];

    const tree = buildUsageTree(groups, [
      session('s1', 'routes', 'user', 3_000_000_000, 100, 50, 5000),
    ]);

    const backend = tree.children[0];
    expect(backend.type).toBe('group');
    expect(backend.totals).toMatchObject({
      sessions: 1,
      inputTokens: 100,
      outputTokens: 50,
      reasoningOutputTokens: 2,
      nanoAiu: 3_000_000_000,
      activeMs: 5000,
      credits: 0.2,
    });
    if (backend.type !== 'group') {
      throw new Error('expected group');
    }
    const api = backend.children[0];
    expect(api.type).toBe('group');
    if (api.type !== 'group') {
      throw new Error('expected nested group');
    }
    const routes = api.children[0];
    expect(routes.type).toBe('group');
    if (routes.type !== 'group') {
      throw new Error('expected leaf group');
    }
    expect(routes.children[0]).toMatchObject({
      type: 'session',
      id: 's1',
      origin: 'user',
    });
    expect(tree.totals.sessions).toBe(1);
  });

  it('keeps PR-kind groups and IDE metasessions in the tree', () => {
    const tree = buildUsageTree(
      [{ id: 'pr-42', name: 'PR #42', kind: 'pr', parentGroupId: null }],
      [session('m1', 'pr-42', 'ide', 2_000_000_000)],
    );

    expect(tree.children[0]).toMatchObject({
      type: 'group',
      id: 'pr-42',
      kind: 'pr',
      totals: { sessions: 1, nanoAiu: 2_000_000_000 },
    });
    const pr = tree.children[0];
    if (pr.type !== 'group') {
      throw new Error('expected PR group');
    }
    expect(pr.children[0]).toMatchObject({
      type: 'session',
      id: 'm1',
      origin: 'ide',
    });
  });

  it('places ungrouped and orphan sessions under the feature root', () => {
    const tree = buildUsageTree(
      [{ id: 'known', name: 'Known', kind: 'subcategory', parentGroupId: null }],
      [
        session('ungrouped', null, 'user', 1_000_000_000),
        session('orphan', 'missing', 'ide', 4_000_000_000),
      ],
    );

    expect(tree.children.map((child) => child.id)).toEqual([
      'known',
      'ungrouped',
      'orphan',
    ]);
    expect(tree.totals).toMatchObject({
      sessions: 2,
      inputTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      nanoAiu: 5_000_000_000,
      activeMs: 2000,
      cost: 0.2,
      credits: 0.4,
    });
  });

  it('promotes groups whose parent is missing to the feature root', () => {
    const tree = buildUsageTree(
      [{ id: 'orphan-group', name: 'Orphan group', kind: 'subcategory', parentGroupId: 'missing' }],
      [session('s1', 'orphan-group', 'user', 1_000_000_000)],
    );

    expect(tree.children[0]).toMatchObject({
      type: 'group',
      id: 'orphan-group',
      totals: { sessions: 1 },
    });
  });
});
