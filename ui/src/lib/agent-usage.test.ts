import { describe, expect, it } from 'vitest';
import { aggregateAgentUsage, refreshAgentCredits } from './agent-usage.js';
import type { MetaOperationSummary } from '../features/meta-operations/meta-operation-types.js';

export function usageOperation(overrides: Partial<MetaOperationSummary> = {}): MetaOperationSummary {
  return {
    operationId: 'one', featureId: 'feature', automationId: null, originSessionId: null,
    providerId: 'copilot', requestedModel: 'auto', resolvedModel: null,
    sessionId: 's', sessionIds: ['s'], providerSessionId: 'vendor', transport: 'warm-acp',
    state: 'completed', outcome: 'returned', label: 'Review board · security', purpose: null,
    errorMessage: null, usageState: 'recorded', hasResult: true,
    usage: { inputTokens: 10, outputTokens: 2, nanoAiu: 2e9, credits: 999 },
    createdAt: 't', updatedAt: 't', startedAt: 't', finishedAt: 't', ...overrides,
  };
}

describe('agent usage aggregation', () => {
  it('uses vendor nano-AIU, deduplicates operations, includes charged failures and legacy board labels', () => {
    const ops = [
      usageOperation(), usageOperation(),
      usageOperation({ operationId: 'retry', state: 'failed' }),
      usageOperation({ operationId: 'old', label: 'Review board' }),
      usageOperation({ operationId: 'other', label: 'New task' }),
    ];
    expect(aggregateAgentUsage(ops, 'Review board')).toEqual({
      aic: 6, operations: 3, unknownOperations: 0, running: false,
    });
    expect(aggregateAgentUsage(ops, 'Review board', 'security').aic).toBe(4);
    expect(aggregateAgentUsage(ops, 'Review board', 'testing').aic).toBeNull();
  });
  it('distinguishes partial, missing, pending and genuine zero usage without fabricating costs', () => {
    const ops = [
      usageOperation({ usage: null, state: 'pending', outcome: 'not-dispatched' }),
      usageOperation({ operationId: 'failed-before-start', state: 'failed', outcome: 'not-dispatched' }),
      usageOperation({ operationId: 'invalid', usage: { inputTokens: null, outputTokens: null, nanoAiu: -1, credits: 3 } }),
    ];
    expect(aggregateAgentUsage(ops, 'Review board')).toEqual({
      aic: null, operations: 2, unknownOperations: 2, running: true,
    });
    ops.push(usageOperation({ operationId: 'zero', usage: { inputTokens: 0, outputTokens: 0, nanoAiu: 0, credits: 0 } }));
    expect(aggregateAgentUsage(ops, 'Review board')).toMatchObject({ aic: 0, unknownOperations: 2 });
  });
  it('hydrates agent windows by physical identity rather than an ambiguous title', () => {
    const old = { credits: 7 };
    const agents = [old, { credits: null, sessionIds: ['s'] }, { credits: 3, sessionIds: ['missing'] }];
    expect(refreshAgentCredits(agents, [usageOperation(), usageOperation()])).toEqual([
      old, { credits: 2, sessionIds: ['s'] }, { credits: null, sessionIds: ['missing'] },
    ]);
  });
});
