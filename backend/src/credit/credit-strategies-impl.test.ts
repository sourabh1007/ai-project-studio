import { describe, it, expect } from 'vitest';
import { createProviderCostStrategy } from './strategies/provider-cost-strategy.js';
import { createTokenRateStrategy } from './strategies/token-rate-strategy.js';
import { createPremiumRequestStrategy } from './strategies/premium-request-strategy.js';
import { createRateTable } from './rate-table-provider.js';
import { creditDefaults } from './config.js';
import type { UsageEvent } from '../usage/usage-contract.js';

function usage(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    operation: 'chat',
    inputTokens: 1000,
    outputTokens: 200,
    reasoningOutputTokens: 10,
    cost: 0.33,
    nanoAiu: 1167825000,
    serviceRequestId: 'req-1',
    startedAt: '1970-01-01T00:00:10.000Z',
    endedAt: '1970-01-01T00:00:12.000Z',
    ...overrides,
  };
}

describe('credit strategies', () => {
  it('provider-cost scales the reported cost', () => {
    const strategy = createProviderCostStrategy({ multiplier: 2 });
    expect(strategy.id).toBe('provider-cost');
    expect(strategy.compute(usage({ cost: 0.5 }))).toBe(1);
  });

  it('token-rate prices input and output tokens by resolved model', () => {
    const table = createRateTable({
      ...creditDefaults,
      tokenRate: {
        default: { inputPerToken: 0, outputPerToken: 0 },
        perModel: { 'gpt-5.4-mini': { inputPerToken: 0.001, outputPerToken: 0.01 } },
      },
    });
    const strategy = createTokenRateStrategy(table);
    expect(strategy.id).toBe('token-rate');
    expect(strategy.compute(usage({ inputTokens: 1000, outputTokens: 200 }))).toBeCloseTo(3);
  });

  it('premium-request charges the per-model multiplier', () => {
    const table = createRateTable({
      ...creditDefaults,
      premiumRequest: { default: 1, perModel: { 'gpt-5.4-mini': 0.33 } },
    });
    const strategy = createPremiumRequestStrategy(table);
    expect(strategy.id).toBe('premium-request');
    expect(strategy.compute(usage())).toBe(0.33);
  });
});
