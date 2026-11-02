import { describe, expect, it } from 'vitest';
import { featureUsageRevision, workspaceUsageRevision } from './feature-usage-freshness.js';
import { applyStreamEvent, initialLiveState, type LiveState } from './stream.js';
import type { Session, StoredUsage } from './types.js';

function usage(overrides: Partial<StoredUsage> = {}): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'interactive',
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'auto',
    operation: 'chat',
    serviceRequestId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    nanoAiu: 1,
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
    activeMs: 1,
    ...overrides,
  } as StoredUsage;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'interactive',
    prompt: '',
    usageFilePath: '/tmp/u.jsonl',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    ...overrides,
  } as Session;
}

function live(overrides: Partial<LiveState> = {}): LiveState {
  return { ...initialLiveState, ...overrides };
}

describe('featureUsageRevision', () => {
  it('is stable while nothing relevant has happened', () => {
    const state = live({ usageByKey: { a: usage() } });
    expect(featureUsageRevision(state, 'f1')).toBe(
      featureUsageRevision(state, 'f1'),
    );
  });

  it('changes when a new turn is recorded for the feature', () => {
    const before = featureUsageRevision(live({ usageByKey: { a: usage() } }), 'f1');
    const after = featureUsageRevision(
      live({ usageByKey: { a: usage(), b: usage({ turnIndex: 1 }) } }),
      'f1',
    );
    expect(after).not.toBe(before);
  });

  it('changes when an existing turn is superseded by a later one', () => {
    const before = featureUsageRevision(live({ usageByKey: { a: usage() } }), 'f1');
    const after = featureUsageRevision(
      live({ usageByKey: { a: usage({ endedAt: '2026-01-01T00:00:09.000Z' }) } }),
      'f1',
    );
    expect(after).not.toBe(before);
  });

  it('ignores usage belonging to a different feature', () => {
    const base = featureUsageRevision(live({ usageByKey: { a: usage() } }), 'f1');
    const withOther = featureUsageRevision(
      live({ usageByKey: { a: usage(), b: usage({ featureId: 'other' }) } }),
      'f1',
    );
    expect(withOther).toBe(base);
  });

  it('changes when a session for the feature finishes', () => {
    const before = featureUsageRevision(live({ sessions: { s1: session() } }), 'f1');
    const after = featureUsageRevision(
      live({ sessions: { s1: session({ status: 'completed' }) } }),
      'f1',
    );
    expect(after).not.toBe(before);
  });

  it('ignores sessions belonging to a different feature', () => {
    const base = featureUsageRevision(live({ sessions: { s1: session() } }), 'f1');
    const withOther = featureUsageRevision(
      live({
        sessions: { s1: session(), s2: session({ id: 's2', featureId: 'other' }) },
      }),
      'f1',
    );
    expect(withOther).toBe(base);
  });

  it('does not change merely because cache iteration order differs', () => {
    // The live caches evict, so the same content can be enumerated in a
    // different order. That must not read as new usage.
    const a = session({ id: 'a' });
    const b = session({ id: 'b' });
    expect(featureUsageRevision(live({ sessions: { a, b } }), 'f1')).toBe(
      featureUsageRevision(live({ sessions: { b, a } }), 'f1'),
    );
  });

  it('is empty-but-defined for a feature with no activity', () => {
    expect(featureUsageRevision(live(), 'f1')).toBe('0|||0|0');
  });

  it('changes when warm-meta usage lands for that feature only', () => {
    const before = featureUsageRevision(initialLiveState, 'f1');
    const after = applyStreamEvent(initialLiveState, { type: 'meta.usage.updated', featureId: 'f1', operationId: 'op' });
    expect(featureUsageRevision(after, 'f1')).not.toBe(before);
    expect(featureUsageRevision(after, 'f2')).toBe(featureUsageRevision(initialLiveState, 'f2'));
  });

  it('changes across a stream gap even when no usage was cached', () => {
    const before = featureUsageRevision(initialLiveState, 'f1');
    let state = applyStreamEvent(initialLiveState, { type: 'stream.interrupted' });
    state = applyStreamEvent(state, { type: 'stream.reconnected' });
    expect(featureUsageRevision(state, 'f1')).not.toBe(before);
    expect(featureUsageRevision(applyStreamEvent(state, { type: 'stream.truncated' }), 'f1'))
      .not.toBe(featureUsageRevision(state, 'f1'));
  });});

describe('workspaceUsageRevision', () => {
  const a = live({
    usageByKey: { k1: usage({ featureId: 'f1' }), k2: usage({ featureId: 'f2', sessionId: 's2', endedAt: '2026-01-02T00:00:00.000Z' }) },
    sessions: { s1: session(), s2: session({ id: 's2', featureId: 'f2' }) },
    metaUsageByFeature: { f1: 1, f2: 2 },
    streamEpoch: 3,
  });

  it('aggregates usage, sessions, meta usage and stream epoch across all features', () => {
    expect(workspaceUsageRevision(a)).toBe('2|2026-01-02T00:00:00.000Z|s1:running,s2:running|3|3');
  });

  it('changes when any feature changes or the stream gaps', () => {
    const base = workspaceUsageRevision(a);
    expect(workspaceUsageRevision({ ...a, metaUsageByFeature: { f1: 1, f2: 3 } })).not.toBe(base);
    expect(workspaceUsageRevision({ ...a, streamEpoch: 4 })).not.toBe(base);
    expect(workspaceUsageRevision({ ...a, sessions: { ...a.sessions, s2: session({ id: 's2', featureId: 'f2', status: 'completed' }) } })).not.toBe(base);
  });

  it('is stable for an empty live state', () => {
    expect(workspaceUsageRevision(live())).toBe('0|||0|0');
  });
});
