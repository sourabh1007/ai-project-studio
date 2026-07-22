import { describe, it, expect } from 'vitest';
import { createCreditCalculator } from './credit-calculator.js';
import { createBuiltinCreditStrategies } from './credit-strategies.js';
import { creditDefaults } from './config.js';
import { AppError } from '../kernel/error-types.js';
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

describe('credit-calculator', () => {
  it('costs an event using the configured active strategy', () => {
    const strategies = createBuiltinCreditStrategies(creditDefaults);
    const calc = createCreditCalculator(strategies, {
      activeStrategy: creditDefaults.activeStrategy,
      unit: creditDefaults.unit,
    });
    expect(calc.strategyId).toBe('provider-cost');
    expect(calc.calculate(usage({ cost: 0.33 }))).toEqual({
      strategy: 'provider-cost',
      unit: 'credits',
      credits: 0.33,
    });
  });

  it('supports switching the active strategy', () => {
    const strategies = createBuiltinCreditStrategies({
      ...creditDefaults,
      premiumRequest: { default: 1, perModel: { 'gpt-5.4-mini': 0.33 } },
    });
    const calc = createCreditCalculator(strategies, {
      activeStrategy: 'premium-request',
      unit: 'requests',
    });
    expect(calc.calculate(usage()).credits).toBe(0.33);
  });

  it('throws a config error for an unknown strategy', () => {
    const strategies = createBuiltinCreditStrategies(creditDefaults);
    expect(() =>
      createCreditCalculator(strategies, { activeStrategy: 'nope', unit: 'credits' }),
    ).toThrow(AppError);
  });
});
