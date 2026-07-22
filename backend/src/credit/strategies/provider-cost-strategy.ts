import type { CreditStrategy } from '../credit-contract.js';

/**
 * Uses the provider-reported cost (github.copilot.cost) as the credit amount,
 * scaled by a configurable multiplier. This is the source-of-truth strategy.
 */
export function createProviderCostStrategy(config: {
  multiplier: number;
}): CreditStrategy {
  return {
    id: 'provider-cost',
    compute: (event) => event.cost * config.multiplier,
  };
}
