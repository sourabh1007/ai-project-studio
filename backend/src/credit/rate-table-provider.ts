import type { CreditConfig, TokenRate } from './config.js';

/** Resolves per-model rates and multipliers from configuration. */
export interface RateTable {
  tokenRateFor(model: string): TokenRate;
  premiumMultiplierFor(model: string): number;
}

export function createRateTable(config: CreditConfig): RateTable {
  return {
    tokenRateFor(model) {
      return config.tokenRate.perModel[model] ?? config.tokenRate.default;
    },
    premiumMultiplierFor(model) {
      return config.premiumRequest.perModel[model] ?? config.premiumRequest.default;
    },
  };
}
