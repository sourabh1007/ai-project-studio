import type { CreditConfig } from './config.js';
import type { CreditStrategy } from './credit-contract.js';
import { createRateTable } from './rate-table-provider.js';
import { createProviderCostStrategy } from './strategies/provider-cost-strategy.js';
import { createTokenRateStrategy } from './strategies/token-rate-strategy.js';
import { createPremiumRequestStrategy } from './strategies/premium-request-strategy.js';

/** Builds the built-in credit strategies wired to the given configuration. */
export function createBuiltinCreditStrategies(
  config: CreditConfig,
): CreditStrategy[] {
  const rateTable = createRateTable(config);
  return [
    createProviderCostStrategy(config.providerCost),
    createTokenRateStrategy(rateTable),
    createPremiumRequestStrategy(rateTable),
  ];
}
