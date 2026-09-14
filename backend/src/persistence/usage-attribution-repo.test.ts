import { describe, expect, it } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageRepo } from './usage-repo.js';
import { createMetaUsageRepo } from './meta-usage-repo.js';
import { createMetaOperationRepo } from './meta-operation-repo.js';
import { createUsageAttributionRepo } from './usage-attribution-repo.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

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
    inputTokens: 1,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    cost: 0,
    credits: 1,
    nanoAiu: 1,
    serviceRequestId: 'req',
    startedAt: '2026-01-01T00:00:02.000Z',
    endedAt: '2026-01-01T00:00:03.000Z',
    ...overrides,
  };
}

describe('createUsageAttributionRepo', () => {
  it('re-homes a session\'s events, meta usage and operations onto a new feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    createUsageRepo(db).saveAll([usage({ sessionId: 's1', featureId: 'f1' })]);
    createMetaUsageRepo(db).save({
      sessionId: 's1',
      featureId: 'f1',
      providerId: 'copilot',
      requestedModel: 'auto',
      resolvedModel: null,
      transport: 'warm-acp',
      providerSessionId: null,
      purpose: null,
      label: null,
      inputTokens: null,
      outputTokens: null,
      nanoAiu: null,
      credits: null,
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
    const operations = createMetaOperationRepo(db);
    operations.create({
      operationId: 'op1',
      featureId: 'f1',
      automationId: null,
      originSessionId: 's1',
      providerId: 'copilot',
      requestedModel: 'auto',
      resolvedModel: null,
      sessionId: 's1',
      providerSessionId: null,
      sessionIds: ['s1'],
      transport: 'warm-acp',
      state: 'running',
      outcome: 'unknown',
      purpose: null,
      label: null,
      resultText: null,
      errorMessage: null,
      usageState: 'unknown',
      usage: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    });

    createUsageAttributionRepo(db).reassignSessionFeature('s1', 'f2');

    expect(
      db.prepare('SELECT feature_id FROM usage_events WHERE session_id = ?').get('s1'),
    ).toEqual({ feature_id: 'f2' });
    expect(createMetaUsageRepo(db).get('s1')?.featureId).toBe('f2');
    expect(operations.get('op1')?.featureId).toBe('f2');
    db.close();
  });
});
