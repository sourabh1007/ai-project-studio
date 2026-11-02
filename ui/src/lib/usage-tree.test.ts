import { describe, expect, it } from 'vitest';
import { buildUsageTree, usageReliability, usageTotalsByNode } from './usage-tree.js';
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
  it('does not label mixed known and unavailable native charges as a complete zero or partial total', () => {
    const unknown = { ...session('claude', null, 'user', 0), cost: null, credits: null, nanoAiu: null };
    for (const members of [
      [unknown, session('known', null, 'user', 100)],
      [session('known', null, 'user', 100), unknown, session('later', null, 'user', 0)],
    ]) {
      expect(buildUsageTree([], members).totals).toMatchObject({ cost: null, credits: null, nanoAiu: null });
    }
  });
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

  it('keeps known partial amounts and reliability through nested groups', () => {
    const groups = [
      { id: 'a', name: 'A', kind: 'subcategory', parentGroupId: null },
      { id: 'b', name: 'B', kind: 'subcategory', parentGroupId: 'a' },
    ] as GroupInfo[];
    const unknown = { ...session('c', 'b', 'user', 0), cost: null, credits: null, nanoAiu: null };
    const partial = { ...session('p', 'b', 'ide', 0), cost: null, credits: null, nanoAiu: null,
      knownCost: 1, knownCredits: 2, knownNanoAiu: 30, unavailableCharges: 1, usdEstimate: 0.5 };
    const tree = buildUsageTree(groups, [unknown, partial, session('k', 'a', 'user', 100)]);
    const byId = usageTotalsByNode(tree);
    expect(byId.get('b')).toMatchObject({ sessions: 2, credits: null, knownCredits: 2, knownNanoAiu: 30, unavailableCharges: 2, usdEstimate: 0.5 });
    expect(byId.get('a')).toMatchObject({ sessions: 3, knownCredits: 2.2, knownNanoAiu: 130, unavailableCharges: 2 });
    expect(byId.get('feature')).toMatchObject({ sessions: 3, unavailableCharges: 2 });
    expect(usageReliability(byId.get('b')!)).toBe('partial');
    expect(usageReliability({ ...byId.get('b')!, knownCredits: 0, knownNanoAiu: 0 })).toBe('unavailable');
    expect(usageReliability(byId.get('feature')!)).toBe('partial');
    expect(usageReliability(buildUsageTree([], []).totals)).toBe('none');
    expect(usageReliability(buildUsageTree([], [session('k', null, 'user', 1)]).totals)).toBe('complete');
    expect(buildUsageTree([], [session('k', null, 'user', 1)]).totals).not.toHaveProperty('unavailableCharges');
  });

  it('never drops or double counts usage for cyclic, self-parented, or duplicate groups/sessions', () => {
    const groups = [
      { id: 'a', name: 'A', kind: 'subcategory', parentGroupId: 'b' },
      { id: 'b', name: 'B', kind: 'subcategory', parentGroupId: 'a' },
      { id: 's', name: 'S', kind: 'subcategory', parentGroupId: 's' },
      { id: 's', name: 'S again', kind: 'subcategory', parentGroupId: null },
    ] as GroupInfo[];
    const tree = buildUsageTree(groups, [
      session('x', 'a', 'user', 10), session('x', 'a', 'user', 10), session('y', 's', 'user', 10),
    ]);
    expect(tree.totals.sessions).toBe(2);
    expect(tree.totals.nanoAiu).toBe(20);
    expect([...usageTotalsByNode(tree).keys()].sort()).toEqual(['a', 'b', 'feature', 's']);
  });
  it('folds retained deleted-session usage into the root without a child row', () => {
    const retained = { sessions: 2, inputTokens: 7, outputTokens: 1, reasoningOutputTokens: 0, cost: null, credits: null, nanoAiu: null,
      knownCost: 0, knownCredits: 3, knownNanoAiu: 9, unavailableCharges: 1 };
    const tree = buildUsageTree([], [session('k', null, 'user', 100)], retained);
    expect(tree.children).toHaveLength(1);
    expect(tree.totals).toMatchObject({ sessions: 3, inputTokens: 17, nanoAiu: null, knownNanoAiu: 109, knownCredits: 3.2, unavailableCharges: 1 });
    expect(tree.retained).toMatchObject({ sessions: 2, activeMs: 0 });
    expect(buildUsageTree([], [], { ...retained, sessions: 0 })).not.toHaveProperty('retained');
    const complete = buildUsageTree([], [session('k', null, 'user', 100)], { ...retained, cost: 0, credits: 1, nanoAiu: 5, unavailableCharges: undefined });
    expect(complete.totals).toMatchObject({ nanoAiu: 105 });
    expect(complete.totals).not.toHaveProperty('unavailableCharges');
  });
  it('classifies reliability without known fields and tolerates cost-only gaps', () => {
    const base = { sessions: 1, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, cost: 0, credits: null, nanoAiu: null, activeMs: 0 };
    expect(usageReliability(base)).toBe('unavailable');
    expect(usageReliability({ ...base, knownNanoAiu: 0, knownCredits: 5 })).toBe('partial');
    expect(usageReliability({ ...base, knownNanoAiu: 4 })).toBe('partial');
    const costGap = { ...session('c', null, 'user', 10), cost: null };
    const retained = { sessions: 1, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, cost: null, credits: 1, nanoAiu: 5 };
    const tree = buildUsageTree([], [costGap], retained);
    expect(tree.totals).toMatchObject({ cost: null, credits: 1.2, nanoAiu: 15 });
    expect(tree.totals).not.toHaveProperty('unavailableCharges');
    const bare = buildUsageTree([], [{ ...session('m', null, 'user', 1), usdEstimate: 2 }], { ...retained, usdEstimate: 1 });
    expect(bare.totals.usdEstimate).toBe(3);
  });
  it('treats null charges without known amounts as zero lower bounds when merging', () => {
    const nulls = { ...session('n', null, 'user', 0), credits: null, nanoAiu: null, unavailableCharges: 0 };
    const retained = { sessions: 1, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, cost: 0, credits: null, nanoAiu: null };
    const tree = buildUsageTree([], [nulls], retained);
    expect(tree.totals).toMatchObject({ credits: null, nanoAiu: null });
  });});
