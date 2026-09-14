import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createMetaUsageRepo } from './meta-usage-repo.js';

function record() {
  return {
    sessionId: 'warm-1',
    featureId: 'f1',
    providerId: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    transport: 'warm-acp' as const,
    providerSessionId: 'provider-1',
    purpose: 'review',
    label: 'PR review',
    inputTokens: 10,
    outputTokens: 4,
    nanoAiu: null,
    credits: null,
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('createMetaUsageRepo', () => {
  it('round-trips warm usage records', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMetaUsageRepo(db);
    repo.save(record());

    expect(repo.get('warm-1')).toEqual(record());
  });

  it('purges records by feature or session ownership', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMetaUsageRepo(db);
    repo.save(record());
    repo.save({ ...record(), sessionId: 'warm-2', featureId: 'f2' });

    repo.deleteBySession('warm-1');
    expect(repo.get('warm-1')).toBeNull();
    expect(repo.get('warm-2')).not.toBeNull();

    repo.deleteByFeature('f2');
    expect(repo.get('warm-2')).toBeNull();
  });

  it('lists recent records newest-first, bounded by limit', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createMetaUsageRepo(db);
    repo.save({ ...record(), sessionId: 'warm-1', capturedAt: '2026-01-01T00:00:00.000Z' });
    repo.save({ ...record(), sessionId: 'warm-2', capturedAt: '2026-03-01T00:00:00.000Z' });
    repo.save({ ...record(), sessionId: 'warm-3', capturedAt: '2026-02-01T00:00:00.000Z' });

    expect(repo.listRecent(2).map((r) => r.sessionId)).toEqual(['warm-2', 'warm-3']);
  });
});
