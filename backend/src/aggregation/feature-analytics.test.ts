import { describe, it, expect } from 'vitest';
import {
  createFeatureAnalytics,
  sessionActiveMs,
  type SessionLister,
} from './feature-analytics.js';
import { createClock } from '../kernel/clock.js';
import type { Session } from '../session/session-contract.js';
import type {
  AggregateReader,
  SessionUsage,
  UsageTotals,
} from './aggregation-contract.js';

const NOW = Date.parse('2025-01-01T01:00:00.000Z');

function session(overrides: Partial<Session>): Session {
  return {
    id: 's',
    featureId: 'f1',
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'dev',
    prompt: 'p',
    usageFilePath: '/tmp/u.jsonl',
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

const zero: UsageTotals = {
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  cost: 0,
  credits: 0,
  nanoAiu: 0,
};

function usage(sessionId: string, overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    sessionId,
    sessions: 1,
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.5,
    credits: 0.5,
    nanoAiu: 1000,
    ...overrides,
  };
}

function harness(opts: {
  members: Session[];
  usages: SessionUsage[];
  all?: Session[];
}) {
  const reader: AggregateReader = {
    featureTotals: () => ({ ...zero, sessions: 1, credits: 9, nanoAiu: 42 }),
    byModel: () => [{ model: 'm', ...zero }],
    byProvider: () => [{ provider: 'github', ...zero }],
    byDay: () => [{ day: '2025-01-01', ...zero }],
    bySession: () => opts.usages,
    workspaceTotals: () => ({ ...zero, credits: 77 }),
  };
  const sessions: SessionLister = {
    listByFeature: () => opts.members,
    listAll: () => opts.all ?? opts.members,
  };
  const clock = createClock(() => NOW);
  return createFeatureAnalytics({ reader, sessions, clock });
}

describe('sessionActiveMs', () => {
  it('returns 0 when startedAt is null', () => {
    expect(sessionActiveMs(null, null, NOW)).toBe(0);
  });

  it('returns 0 when startedAt is unparseable', () => {
    expect(sessionActiveMs('not-a-date', null, NOW)).toBe(0);
  });

  it('uses endedAt when present', () => {
    expect(
      sessionActiveMs(
        '2025-01-01T00:00:00.000Z',
        '2025-01-01T00:30:00.000Z',
        NOW,
      ),
    ).toBe(30 * 60 * 1000);
  });

  it('falls back to now while running', () => {
    expect(sessionActiveMs('2025-01-01T00:00:00.000Z', null, NOW)).toBe(
      60 * 60 * 1000,
    );
  });

  it('falls back to now when endedAt is unparseable', () => {
    expect(
      sessionActiveMs('2025-01-01T00:00:00.000Z', 'bad', NOW),
    ).toBe(60 * 60 * 1000);
  });

  it('never returns a negative duration', () => {
    expect(
      sessionActiveMs(
        '2025-01-01T02:00:00.000Z',
        '2025-01-01T00:00:00.000Z',
        NOW,
      ),
    ).toBe(0);
  });
});

describe('createFeatureAnalytics', () => {
  it('joins usage with sessions, overrides count, and sums timing', () => {
    const members = [
      session({ id: 'b', startedAt: '2025-01-01T00:10:00.000Z', endedAt: null }),
      session({
        id: 'a',
        startedAt: '2025-01-01T00:00:00.000Z',
        endedAt: '2025-01-01T00:30:00.000Z',
        status: 'completed',
      }),
      session({
        id: 'c',
        startedAt: null,
        createdAt: '2025-01-01T00:20:00.000Z',
        provider: 'agency',
        kind: 'meta',
      }),
    ];
    const analytics = harness({ members, usages: [usage('a')] });
    const result = analytics.forFeature('f1');

    expect(result.bySession.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(result.totals.sessions).toBe(3);
    expect(result.totals.credits).toBe(9);

    const [a, b, c] = result.bySession;
    expect(a.inputTokens).toBe(100);
    expect(a.activeMs).toBe(30 * 60 * 1000);
    expect(b.inputTokens).toBe(0);
    expect(b.activeMs).toBe(50 * 60 * 1000);
    expect(c.provider).toBe('agency');
    expect(c.kind).toBe('meta');
    expect(c.activeMs).toBe(0);

    expect(result.timing.totalActiveMs).toBe(
      30 * 60 * 1000 + 50 * 60 * 1000,
    );
    expect(result.byModel).toEqual([{ model: 'm', ...zero }]);
    expect(result.byProvider).toEqual([{ provider: 'github', ...zero }]);
    expect(result.byDay).toEqual([{ day: '2025-01-01', ...zero }]);
  });

  it('orders sessions with unparseable start dates last', () => {
    const members = [
      session({ id: 'bad', startedAt: 'not-a-date', createdAt: 'also-bad' }),
      session({ id: 'good', startedAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const analytics = harness({ members, usages: [] });
    const result = analytics.forFeature('f1');
    expect(result.bySession.map((s) => s.sessionId)).toEqual(['good', 'bad']);
  });

  it('delegates workspace totals to the reader', () => {
    const analytics = harness({ members: [], usages: [] });
    expect(analytics.workspaceTotals().credits).toBe(77);
  });

  it('reports workspace stats with active and total session counts', () => {
    const all = [
      session({ id: 'r1', status: 'running' }),
      session({ id: 'r2', status: 'running' }),
      session({ id: 'done', status: 'completed' }),
    ];
    const analytics = harness({ members: [], usages: [], all });
    const stats = analytics.workspaceStats();
    expect(stats.totals.credits).toBe(77);
    expect(stats.activeSessions).toBe(2);
    expect(stats.totalSessions).toBe(3);
  });
});
