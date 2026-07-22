import type { CreditStrategy } from '../credit-contract.js';
import type { RateTable } from '../rate-table-provider.js';

/**
 * Charges a fixed number of "premium requests" per inference call, by resolved
 * model. Mirrors the legacy Copilot premium-request billing model.
 */
export function createPremiumRequestStrategy(
  rateTable: RateTable,
): CreditStrategy {
  return {
    id: 'premium-request',
    compute: (event) => rateTable.premiumMultiplierFor(event.resolvedModel),
  };
}
