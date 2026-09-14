import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageRepo } from './usage-repo.js';
import { createMetaUsageRepo } from './meta-usage-repo.js';
import { createRetainedUsageRepo } from './retained-usage-repo.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';
import type { RetainSessionInput } from '../usage-retention/usage-retention-contract.js';

function usage(overrides: Partial<StoredUsage>): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.3,
    credits: 0.3,
    nanoAiu: 1000,
    serviceRequestId: 'req',
    startedAt: '2026-01-01T00:00:02.000Z',
    endedAt: '2026-01-01T00:00:03.000Z',
    ...overrides,
  };
}

function retainInput(overrides: Partial<RetainSessionInput> = {}): RetainSessionInput {
  return {
    sessionId: 's1',
    featureId: 'f1',
    featureName: 'Feature One',
    sessionKind: 'dev',
    scope: 'feature',
    reason: 'session-deleted',
    retainedAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  };
}

function retainedRows(db: ReturnType<typeof createDatabase>): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM retained_usage ORDER BY source, day')
    .all() as Record<string, unknown>[];
}

describe('createRetainedUsageRepo', () => {
  it('rolls a session\'s CLI turns into day/provider/model buckets', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const usageRepo = createUsageRepo(db);
    usageRepo.saveAll([
      usage({ turnIndex: 0, credits: 0.3, inputTokens: 100 }),
      usage({ turnIndex: 1, credits: 0.7, inputTokens: 200 }),
      usage({
        turnIndex: 2,
        resolvedModel: 'claude',
        credits: 5,
        startedAt: '2026-01-02T00:00:00.000Z',
        endedAt: '2026-01-02T00:00:01.000Z',
      }),
    ]);
    createRetainedUsageRepo(db).summarizeSession(retainInput());

    const rows = retainedRows(db);
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first.source).toBe('cli');
    expect(first.feature_name).toBe('Feature One');
    expect(first.reason).toBe('session-deleted');
    expect(first.day).toBe('2026-01-01');
    expect(first.credits).toBeCloseTo(1);
    expect(first.input_tokens).toBe(300);
    expect(first.sessions).toBe(1);
    db.close();
  });

  it('retains the warm-ACP meta snapshot as its own row', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    createMetaUsageRepo(db).save({
      sessionId: 's1',
      featureId: 'f1',
      providerId: 'copilot',
      requestedModel: 'auto',
      resolvedModel: 'gpt-5.4',
      transport: 'warm-acp',
      providerSessionId: 'p1',
      purpose: 'review',
      label: 'PR review',
      inputTokens: 12,
      outputTokens: 3,
      nanoAiu: 500,
      credits: null,
      capturedAt: '2026-01-03T00:00:00.000Z',
    });
    createRetainedUsageRepo(db).summarizeSession(
      retainInput({ sessionKind: 'meta', scope: 'internal' }),
    );

    const rows = retainedRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('meta');
    expect(rows[0].scope).toBe('internal');
    expect(rows[0].resolved_model).toBe('gpt-5.4');
    expect(rows[0].purpose).toBe('review');
    expect(rows[0].nano_aiu).toBe(500);
    expect(rows[0].credits).toBe(0);
    db.close();
  });

  it('writes nothing for a session with no usage', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    createRetainedUsageRepo(db).summarizeSession(retainInput({ sessionId: 'ghost' }));
    expect(retainedRows(db)).toHaveLength(0);
    db.close();
  });

  it('ignores a duplicate summarize instead of double counting', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    createUsageRepo(db).saveAll([usage({ turnIndex: 0 })]);
    const repo = createRetainedUsageRepo(db);
    repo.summarizeSession(retainInput());
    repo.summarizeSession(retainInput());
    expect(retainedRows(db)).toHaveLength(1);
    db.close();
  });
});
