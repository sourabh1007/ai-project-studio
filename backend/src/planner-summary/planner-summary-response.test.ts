import { describe, expect, it } from 'vitest';
import { plannerSummaryDefaults } from './config.js';
import { finalizeSummary } from './planner-summary-response.js';

const config = plannerSummaryDefaults;

describe('finalizeSummary', () => {
  it('trims surrounding whitespace', () => {
    expect(finalizeSummary('  A tidy summary.  ', config)).toBe(
      'A tidy summary.',
    );
  });

  it('returns an empty string for blank text', () => {
    expect(finalizeSummary('   \n ', config)).toBe('');
  });

  it('leaves text within the limit unchanged', () => {
    const text = 'x'.repeat(config.maxSummaryChars);
    expect(finalizeSummary(text, config)).toBe(text);
  });

  it('clamps overly long summaries with an ellipsis', () => {
    const long = 'x'.repeat(config.maxSummaryChars + 50);
    const result = finalizeSummary(long, config);
    expect(result.length).toBe(config.maxSummaryChars + 1);
    expect(result.endsWith('…')).toBe(true);
  });
});
