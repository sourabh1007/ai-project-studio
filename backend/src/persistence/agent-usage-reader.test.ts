import { describe, it, expect } from 'vitest';
import { type DatabaseSync } from 'node:sqlite';
import { createDatabase } from './db/connection.js';
import { createMetaOperationRepo } from './meta-operation-repo.js';
import { createAgentUsageReader } from './agent-usage-reader.js';
import type { MetaOperation } from '../meta/meta-operation-contract.js';

function base(operationId: string, overrides: Partial<MetaOperation> = {}): MetaOperation {
  return {
    operationId, featureId: 'f', automationId: null, originSessionId: null, providerId: 'copilot',
    requestedModel: 'auto', resolvedModel: null, sessionId: 's', providerSessionId: 'p',
    sessionIds: ['s'], transport: 'warm-acp', state: 'running', outcome: 'unknown',
    purpose: null, label: null, resultText: null, errorMessage: null, usageState: 'unknown',
    usage: null, createdAt: 't', updatedAt: 't', startedAt: 't', finishedAt: null, ...overrides,
  };
}

function seedCompleted(
  repo: ReturnType<typeof createMetaOperationRepo>,
  id: string,
  label: string | null,
  usage: MetaOperation['usage'],
): void {
  const op = base(id, { label });
  repo.create(op);
  repo.complete(
    { ...op, state: 'completed', outcome: 'returned', resultText: 'done', usageState: 'recorded', usage },
    null,
  );
}

describe('agent-usage-reader', () => {
  let db: DatabaseSync;
  function reader() {
    db = createDatabase({ databasePath: ':memory:' });
    return { repo: createMetaOperationRepo(db), usage: createAgentUsageReader(db) };
  }

  it('sums credits and nano-AIU and counts recorded runs for a label', () => {
    const { repo, usage } = reader();
    seedCompleted(repo, '1', 'Review board', { inputTokens: 1, outputTokens: 2, nanoAiu: 10, credits: 4 });
    seedCompleted(repo, '2', 'Review board', { inputTokens: 3, outputTokens: 4, nanoAiu: 20, credits: 6 });
    seedCompleted(repo, '3', 'Other', { inputTokens: 1, outputTokens: 1, nanoAiu: 5, credits: 9 });
    expect(usage.aggregateByLabel('Review board')).toEqual({ credits: 10, nanoAiu: 30, runs: 2 });
    db.close();
  });

  it('ignores operations that are not completed-and-recorded', () => {
    const { repo, usage } = reader();
    // pending/running operation with the label but no recorded usage
    repo.create(base('1', { label: 'Review board' }));
    expect(usage.aggregateByLabel('Review board')).toEqual({ credits: null, nanoAiu: null, runs: 0 });
    db.close();
  });

  it('counts a run but reports null totals when its usage snapshot is absent', () => {
    const { repo, usage } = reader();
    seedCompleted(repo, '1', 'Review board', null);
    expect(usage.aggregateByLabel('Review board')).toEqual({ credits: null, nanoAiu: null, runs: 1 });
    db.close();
  });

  it('handles partially-populated usage snapshots', () => {
    const { repo, usage } = reader();
    seedCompleted(repo, '1', 'Review board', { inputTokens: null, outputTokens: null, nanoAiu: 7, credits: null });
    seedCompleted(repo, '2', 'Review board', { inputTokens: null, outputTokens: null, nanoAiu: null, credits: 5 });
    expect(usage.aggregateByLabel('Review board')).toEqual({ credits: 5, nanoAiu: 7, runs: 2 });
    db.close();
  });
});
