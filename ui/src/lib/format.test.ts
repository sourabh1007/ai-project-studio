import { describe, expect, it } from 'vitest';
import {
  formatAic,
  formatCompactNumber,
  formatCost,
  formatCredits,
  formatDateTime,
  formatDuration,
  formatTokens,
  nanoAiuToAic,
  NANO_AIU_PER_AIC,
  statusLabel,
  totalTokens,
} from './format.js';

describe('formatCredits', () => {
  it('formats to two decimals with a unit', () => {
    expect(formatCredits(1.2)).toBe('1.20 credits');
  });
});

describe('nanoAiuToAic', () => {
  it('divides by the nano-AIU constant', () => {
    expect(NANO_AIU_PER_AIC).toBe(1_000_000_000);
    expect(nanoAiuToAic(1_742_242_500)).toBeCloseTo(1.7422425);
    expect(nanoAiuToAic(0)).toBe(0);
  });
});

describe('formatAic', () => {
  it('formats vendor nano-AIU as an AIC figure', () => {
    expect(formatAic(1_742_242_500)).toBe('1.74');
    expect(formatAic(0)).toBe('0.00');
  });
});

describe('formatCost', () => {
  it('formats to two decimals', () => {
    expect(formatCost(0.5)).toBe('0.50');
  });
});

describe('formatTokens', () => {
  it('adds thousands separators', () => {
    expect(formatTokens(12345)).toBe('12,345');
  });
});

describe('formatCompactNumber', () => {
  it('returns the plain value below 1000', () => {
    expect(formatCompactNumber(0)).toBe('0');
    expect(formatCompactNumber(999)).toBe('999');
  });

  it('uses a k suffix in the thousands range', () => {
    expect(formatCompactNumber(1000)).toBe('1k');
    expect(formatCompactNumber(23807)).toBe('23.8k');
  });

  it('uses an M suffix in the millions range', () => {
    expect(formatCompactNumber(1_500_000)).toBe('1.5M');
  });

  it('handles negative values', () => {
    expect(formatCompactNumber(-2500)).toBe('-2.5k');
  });
});

describe('formatDateTime', () => {
  it('returns a dash for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });

  it('returns the raw string for an invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  it('formats a valid ISO timestamp', () => {
    const result = formatDateTime('2025-01-02T03:04:05.000Z');
    expect(typeof result).toBe('string');
    expect(result).not.toBe('—');
    expect(result).not.toBe('2025-01-02T03:04:05.000Z');
  });
});

describe('statusLabel', () => {
  it('maps every status to a label', () => {
    expect(statusLabel('created')).toBe('Created');
    expect(statusLabel('running')).toBe('Running');
    expect(statusLabel('completed')).toBe('Completed');
    expect(statusLabel('failed')).toBe('Failed');
    expect(statusLabel('cancelled')).toBe('Cancelled');
  });
});

describe('totalTokens', () => {
  it('sums input, output and reasoning tokens', () => {
    expect(
      totalTokens({
        inputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      }),
    ).toBe(35);
  });
});

describe('formatDuration', () => {
  it('clamps negative values to zero seconds', () => {
    expect(formatDuration(-5000)).toBe('0s');
  });

  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration(45000)).toBe('45s');
  });

  it('formats minute-scale durations', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('formats hour-scale durations', () => {
    expect(formatDuration(3660000)).toBe('1h 1m');
  });

  it('formats day-scale durations', () => {
    expect(formatDuration(90000000)).toBe('1d 1h');
  });
});
