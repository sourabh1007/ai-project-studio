import { ConfigError } from '../kernel/error-types.js';
import type { UsageEvent } from '../usage/usage-contract.js';
import type { CreditStrategy, CreditResult } from './credit-contract.js';

export interface CreditCalculatorConfig {
  activeStrategy: string;
  unit: string;
}

export interface CreditCalculator {
  readonly strategyId: string;
  calculate(event: UsageEvent): CreditResult;
}

/**
 * Selects the active strategy from a pluggable set (open/closed: adding a
 * strategy needs no change here) and costs usage events with it.
 */
export function createCreditCalculator(
  strategies: CreditStrategy[],
  config: CreditCalculatorConfig,
): CreditCalculator {
  const active = strategies.find((s) => s.id === config.activeStrategy);
  if (!active) {
    throw new ConfigError(`Unknown credit strategy: ${config.activeStrategy}`);
  }
  return {
    strategyId: active.id,
    calculate: (event) => ({
      strategy: active.id,
      unit: config.unit,
      credits: active.compute(event),
    }),
  };
}
