import { describe, it, expect } from 'vitest';
import { createUsageSummaryService } from './usage-summary-service.js';
import type {
  UsageSummaryFeatureRow,
  UsageSummaryGroupRow,
  UsageSummaryReader,
  UsageSummarySessionRow,
  UsageSummaryUsageRow,
} from './usage-summary-contract.js';

function use(sessionId: string, featureId: string, o: Partial<UsageSummaryUsageRow> = {}): UsageSummaryUsageRow {
  return {
    sessionId, featureId, sessions: 1, inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 1,
    cost: 1, credits: 1, nanoAiu: 100, ...o,
  };
}
const feat = (id: string, parentFeatureId: string | null = null, parentGroupId: string | null = null): UsageSummaryFeatureRow =>
  ({ id, parentFeatureId, parentGroupId });
const grp = (id: string, featureId: string, parentGroupId: string | null = null): UsageSummaryGroupRow =>
  ({ id, featureId, parentGroupId });
const ses = (id: string, featureId: string, groupId: string | null = null): UsageSummarySessionRow =>
  ({ id, featureId, groupId });

function run(data: {
  features?: UsageSummaryFeatureRow[]; groups?: UsageSummaryGroupRow[];
  sessions?: UsageSummarySessionRow[]; usage?: UsageSummaryUsageRow[];
}) {
  const reader: UsageSummaryReader = {
    features: () => data.features ?? [], groups: () => data.groups ?? [],
    sessions: () => data.sessions ?? [], usage: () => data.usage ?? [],
  };
  return createUsageSummaryService({ reader }).summary();
}

describe('usage summary service', () => {
  it('is empty with no data', () => {
    expect(run({})).toEqual({ features: {}, unattributed: null });
  });

  it('marks features without sessions as none and sessions without usage as empty, not zero charges', () => {
    const s = run({ features: [feat('f1'), feat('f2')], sessions: [ses('s1', 'f2')] });
    expect(s.features.f1.state).toBe('none');
    expect(s.features.f2).toMatchObject({ state: 'empty', sessionsWithoutUsage: 1 });
    expect(s.features.f2.totals.sessions).toBe(1);
  });

  it('rolls nested groups, features under groups and child features up exactly once', () => {
    const s = run({
      features: [feat('root'), feat('child', 'root'), feat('underGroup', null, 'g2')],
      groups: [grp('g1', 'root'), grp('g2', 'root', 'g1'), grp('cg', 'child')],
      sessions: [ses('a', 'root', 'g2'), ses('b', 'root'), ses('c', 'child', 'cg'), ses('d', 'underGroup'), ses('e', 'child', 'g1')],
      usage: [use('a', 'root'), use('b', 'root'), use('c', 'child'), use('d', 'underGroup'), use('e', 'child')],
    });
    expect(s.features.underGroup.totals).toMatchObject({ sessions: 1, inputTokens: 10, credits: 1 });
    expect(s.features.root.groups.g2.totals).toMatchObject({ sessions: 2, inputTokens: 20 });
    expect(s.features.root.groups.g1.totals.sessions).toBe(2);
    expect(s.features.child.groups.cg.totals.sessions).toBe(1);
    // e: group g1 belongs to another feature -> falls to feature root of 'child'
    expect(s.features.child.totals.sessions).toBe(2);
    expect(s.features.root.totals).toMatchObject({ sessions: 5, inputTokens: 50, credits: 5, cost: 5, nanoAiu: 500 });
    expect(s.features.root.state).toBe('complete');
    expect(s.unattributed).toBeNull();
  });

  it('keeps unavailable charges distinct from zero and reports partial vs unavailable', () => {
    const s = run({
      features: [feat('p'), feat('u'), feat('z')],
      sessions: [ses('a', 'p'), ses('b', 'p'), ses('c', 'u'), ses('d', 'z')],
      usage: [
        use('a', 'p', { usdEstimate: 0.5 }),
        use('b', 'p', { credits: null, nanoAiu: null, cost: null, inputTokens: 7, usdEstimate: 0.25 }),
        use('c', 'u', { credits: null, nanoAiu: null, cost: null }),
        use('d', 'z', { credits: 0, cost: 0, nanoAiu: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }),
      ],
    });
    expect(s.features.p.state).toBe('partial');
    expect(s.features.p.totals).toMatchObject({
      credits: null, inputTokens: 17, knownCredits: 1, knownCost: 1, knownNanoAiu: 100, unavailableCharges: 1, usdEstimate: 0.75,
    });
    expect(s.features.u.state).toBe('unavailable');
    expect(s.features.u.totals.credits).toBeNull();
    expect(s.features.z.state).toBe('complete');
    expect(s.features.z.totals.credits).toBe(0);
    expect(s.features.z.totals.unavailableCharges).toBeUndefined();
  });

  it('propagates partial totals carrying known* fields through the rollup', () => {
    const s = run({
      features: [feat('r'), feat('c', 'r')],
      sessions: [ses('a', 'c'), ses('b', 'r')],
      usage: [use('a', 'c', { credits: null, nanoAiu: null, cost: null, knownCredits: 2, knownCost: 2, knownNanoAiu: 20, unavailableCharges: 3 }), use('b', 'r', { usdEstimate: 1 })],
    });
    expect(s.features.r.totals).toMatchObject({ credits: null, knownCredits: 3, unavailableCharges: 3, usdEstimate: 1 });
    expect(s.features.r.state).toBe('partial');
  });

  it('attributes retained usage of deleted sessions to the feature root', () => {
    const s = run({
      features: [feat('f')], groups: [grp('g', 'f')], sessions: [ses('live', 'f', 'g')],
      usage: [use('live', 'f'), use('gone', 'f')],
    });
    expect(s.features.f.totals.sessions).toBe(2);
    expect(s.features.f.groups.g.totals.sessions).toBe(1);
  });

  it('surfaces unknown-feature usage and sessions as unattributed', () => {
    const s = run({
      features: [feat('f')], sessions: [ses('x', 'ghost')], usage: [use('y', 'ghost'), use('z', 'ghost')],
    });
    expect(s.unattributed).toMatchObject({ totals: { sessions: 3, inputTokens: 20 }, sessionsWithoutUsage: 1, state: 'complete' });
    expect(s.features.f.state).toBe('none');
  });

  it('survives group and feature parent cycles, self parents and dangling parents without double counting', () => {
    const s = run({
      features: [feat('a', 'b'), feat('b', 'a'), feat('self', 'self'), feat('dangling', 'nope', 'nogroup'), feat('toG', null, 'g1')],
      groups: [grp('g1', 'a', 'g2'), grp('g2', 'a', 'g1'), grp('gs', 'a', 'gs'), grp('orphanG', 'ghost'), grp('crossG', 'a', 'other'), grp('other', 'b')],
      sessions: [ses('s1', 'a', 'g1'), ses('s2', 'b'), ses('s3', 'self'), ses('s4', 'dangling'), ses('s5', 'toG')],
      usage: ['s1', 's2', 's3', 's4', 's5'].map((id, i) => use(id, ['a', 'b', 'self', 'dangling', 'toG'][i])),
    });
    // a<->b cycle: a stays under b, the closing edge is dropped; toG sits under a's group g1
    expect(s.features.b.totals.sessions).toBe(3);
    expect(s.features.a.totals.sessions).toBe(2);
    expect(s.features.self.totals.sessions).toBe(1);
    expect(s.features.dangling.totals.sessions).toBe(1);
    expect(s.features.toG.totals.sessions).toBe(1);
    // top-level features partition all 5 sessions exactly once
    expect(['b', 'self', 'dangling'].reduce((n, id) => n + s.features[id].totals.sessions, 0)).toBe(5);
    expect(s.unattributed).toBeNull();
  });
});
