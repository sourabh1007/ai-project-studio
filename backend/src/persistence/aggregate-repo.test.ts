import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageRepo } from './usage-repo.js';
import { createAggregateRepo } from './aggregate-repo.js';
import { aggregationDefaults } from '../aggregation/config.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

function usage(overrides: Partial<StoredUsage>): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.33,
    credits: 0.33,
    nanoAiu: 1000,
    serviceRequestId: 'req',
    startedAt: '2025-01-01T00:00:02.000Z',
    endedAt: '2025-01-01T00:00:03.000Z',
    ...overrides,
  };
}

function seed() {
  const db = createDatabase({ databasePath: ':memory:' });
  const repo = createUsageRepo(db);
  repo.saveAll([
    usage({ sessionId: 's1', turnIndex: 0, resolvedModel: 'gpt-5.4-mini', provider: 'github', inputTokens: 100, credits: 0.33, startedAt: '2025-01-01T00:00:00.000Z' }),
    usage({ sessionId: 's1', turnIndex: 1, resolvedModel: 'gpt-5.4', provider: 'github', inputTokens: 200, credits: 1, startedAt: '2025-01-01T00:00:10.000Z' }),
    usage({ sessionId: 's2', turnIndex: 0, resolvedModel: 'claude-sonnet-4.5', provider: 'agency', inputTokens: 50, credits: 2, startedAt: '2025-01-02T00:00:00.000Z' }),
    // meta session usage — now included in rollups
    usage({ sessionId: 's3', turnIndex: 0, kind: 'meta', credits: 99, inputTokens: 999, startedAt: '2025-01-03T00:00:00.000Z' }),
    // different feature
    usage({ sessionId: 's4', featureId: 'f2', turnIndex: 0, credits: 5, startedAt: '2025-01-01T00:00:00.000Z' }),
  ]);
  return { db, reader: createAggregateRepo(db, aggregationDefaults) };
}

describe('aggregate-repo', () => {
  it('feature totals include dev and meta but exclude other features', () => {
    const { db, reader } = seed();
    const totals = reader.featureTotals('f1');
    expect(totals.sessions).toBe(3);
    expect(totals.credits).toBeCloseTo(0.33 + 1 + 2 + 99);
    expect(totals.inputTokens).toBe(1349);
    db.close();
  });

  it('breaks down by model', () => {
    const { db, reader } = seed();
    const byModel = reader.byModel('f1');
    expect(byModel.map((m) => m.model)).toEqual([
      'claude-sonnet-4.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    db.close();
  });

  it('breaks down by provider', () => {
    const { db, reader } = seed();
    const byProvider = reader.byProvider('f1');
    expect(byProvider.map((p) => p.provider)).toEqual(['agency', 'github']);
    expect(byProvider.find((p) => p.provider === 'github')?.sessions).toBe(2);
    db.close();
  });

  it('breaks down by day', () => {
    const { db, reader } = seed();
    const byDay = reader.byDay('f1');
    expect(byDay.map((d) => d.day)).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
    db.close();
  });

  it('breaks down by session', () => {
    const { db, reader } = seed();
    const bySession = reader.bySession('f1');
    expect(bySession.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
    db.close();
  });

  it('computes workspace totals across features including meta', () => {
    const { db, reader } = seed();
    const totals = reader.workspaceTotals();
    expect(totals.credits).toBeCloseTo(0.33 + 1 + 2 + 99 + 5);
    db.close();
  });
});
