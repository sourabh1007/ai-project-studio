import { describe, it, expect } from 'vitest';
import { createUsageDetailService } from './usage-detail-service.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';
import type { Session } from '../session/session-contract.js';
import type { Feature } from '../feature/feature-contract.js';

function usage(
  sessionId: string,
  featureId: string,
  turnIndex: number,
  startedAt: string,
): StoredUsage {
  return {
    sessionId,
    featureId,
    turnIndex,
    kind: 'dev',
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt',
    operation: 'chat',
    inputTokens: 1,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    cost: 0.1,
    credits: 0.1,
    nanoAiu: 100,
    serviceRequestId: null,
    startedAt,
    endedAt: startedAt,
  };
}

function session(id: string): Session {
  return {
    id,
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt',
    status: 'completed',
    kind: 'dev',
    scope: 'feature',
    prompt: '',
    usageFilePath: `/tmp/${id}.jsonl`,
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:00:10.000Z',
    exitCode: null,
  };
}

function feature(id: string, repoId: string | null): Feature {
  return {
    id,
    name: id,
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    summary: null,
    repoId,
    checkoutPath: null,
  };
}

describe('usage-detail-service', () => {
  it('returns a session\'s per-turn usage unchanged', () => {
    const rows = [usage('s1', 'f1', 0, '2025-01-01T00:00:01.000Z')];
    const service = createUsageDetailService({
      usage: { listBySession: (id) => (id === 's1' ? rows : []) },
      sessions: { listByFeature: () => [] },
      features: { list: () => [] },
    });
    expect(service.forSession('s1')).toEqual(rows);
    expect(service.forSession('other')).toEqual([]);
  });

  it('concatenates a feature\'s sessions and sorts by start time', () => {
    const bySession: Record<string, StoredUsage[]> = {
      s1: [usage('s1', 'f1', 0, '2025-01-01T00:00:05.000Z')],
      s2: [usage('s2', 'f1', 0, '2025-01-01T00:00:01.000Z')],
    };
    const service = createUsageDetailService({
      usage: { listBySession: (id) => bySession[id] ?? [] },
      sessions: {
        listByFeature: (id) =>
          id === 'f1' ? [session('s1'), session('s2')] : [],
      },
      features: { list: () => [] },
    });
    const result = service.forFeature('f1');
    expect(result.map((r) => r.sessionId)).toEqual(['s2', 's1']);
  });

  it('breaks start-time ties by session id then turn index', () => {
    const t = '2025-01-01T00:00:01.000Z';
    const bySession: Record<string, StoredUsage[]> = {
      sb: [usage('sb', 'f1', 0, t)],
      sa: [usage('sa', 'f1', 1, t), usage('sa', 'f1', 0, t)],
    };
    const service = createUsageDetailService({
      usage: { listBySession: (id) => bySession[id] ?? [] },
      sessions: {
        listByFeature: () => [session('sb'), session('sa')],
      },
      features: { list: () => [] },
    });
    const result = service.forFeature('f1');
    expect(result.map((r) => `${r.sessionId}:${r.turnIndex}`)).toEqual([
      'sa:0',
      'sa:1',
      'sb:0',
    ]);
  });

  it('sorts rows with an unparseable start time last', () => {
    const bySession: Record<string, StoredUsage[]> = {
      s1: [usage('s1', 'f1', 0, 'not-a-date')],
      s2: [usage('s2', 'f1', 0, '2025-01-01T00:00:01.000Z')],
    };
    const service = createUsageDetailService({
      usage: { listBySession: (id) => bySession[id] ?? [] },
      sessions: { listByFeature: () => [session('s1'), session('s2')] },
      features: { list: () => [] },
    });
    const result = service.forFeature('f1');
    expect(result.map((r) => r.sessionId)).toEqual(['s2', 's1']);
  });

  it('keeps a stable order when several rows share an unparseable time', () => {
    const bySession: Record<string, StoredUsage[]> = {
      sa: [usage('sa', 'f1', 0, 'nope')],
      sb: [usage('sb', 'f1', 0, 'nope')],
      sc: [usage('sc', 'f1', 0, '2025-01-01T00:00:01.000Z')],
    };
    const service = createUsageDetailService({
      usage: { listBySession: (id) => bySession[id] ?? [] },
      sessions: {
        listByFeature: () => [session('sb'), session('sa'), session('sc')],
      },
      features: { list: () => [] },
    });
    const result = service.forFeature('f1');
    // The parseable row sorts first; the unparseable rows fall back to a
    // stable session-id order after it.
    expect(result.map((r) => r.sessionId)).toEqual(['sc', 'sa', 'sb']);
  });

  it('expands a repo into its features\' sessions and skips other repos', () => {
    const bySession: Record<string, StoredUsage[]> = {
      s1: [usage('s1', 'fa', 0, '2025-01-01T00:00:01.000Z')],
      s2: [usage('s2', 'fb', 0, '2025-01-01T00:00:02.000Z')],
      s3: [usage('s3', 'fc', 0, '2025-01-01T00:00:03.000Z')],
    };
    const sessionsByFeature: Record<string, Session[]> = {
      fa: [session('s1')],
      fb: [session('s2')],
      fc: [session('s3')],
    };
    const service = createUsageDetailService({
      usage: { listBySession: (id) => bySession[id] ?? [] },
      sessions: { listByFeature: (id) => sessionsByFeature[id] ?? [] },
      features: {
        list: () => [
          feature('fa', 'r1'),
          feature('fb', 'r1'),
          feature('fc', 'r2'),
          feature('fd', null),
        ],
      },
    });
    const result = service.forRepo('r1');
    expect(result.map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });
});
