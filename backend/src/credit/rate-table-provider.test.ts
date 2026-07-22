import { describe, it, expect } from 'vitest';
import { createRateTable } from './rate-table-provider.js';
import { creditDefaults } from './config.js';

describe('rate-table-provider', () => {
  it('returns per-model token rate when present, else the default', () => {
    const table = createRateTable({
      ...creditDefaults,
      tokenRate: {
        default: { inputPerToken: 1, outputPerToken: 2 },
        perModel: { 'gpt-5.4': { inputPerToken: 3, outputPerToken: 4 } },
      },
    });
    expect(table.tokenRateFor('gpt-5.4')).toEqual({ inputPerToken: 3, outputPerToken: 4 });
    expect(table.tokenRateFor('other')).toEqual({ inputPerToken: 1, outputPerToken: 2 });
  });

  it('returns per-model premium multiplier when present, else the default', () => {
    const table = createRateTable({
      ...creditDefaults,
      premiumRequest: { default: 1, perModel: { 'gpt-5.4-mini': 0.33 } },
    });
    expect(table.premiumMultiplierFor('gpt-5.4-mini')).toBe(0.33);
    expect(table.premiumMultiplierFor('other')).toBe(1);
  });
});
