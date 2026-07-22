import type { CreditStrategy } from '../credit-contract.js';
import type { RateTable } from '../rate-table-provider.js';

/**
 * Prices a usage event by input/output token counts using per-model rates.
 * Useful when the provider does not report a cost or a custom rate applies.
 */
export function createTokenRateStrategy(rateTable: RateTable): CreditStrategy {
  return {
    id: 'token-rate',
    compute: (event) => {
      const rate = rateTable.tokenRateFor(event.resolvedModel);
      return (
        event.inputTokens * rate.inputPerToken +
        event.outputTokens * rate.outputPerToken
      );
    },
  };
}
