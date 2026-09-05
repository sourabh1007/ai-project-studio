import { describe, it, expect } from 'vitest';
import { parsePlanUsage, stripAnsi } from './plan-usage-parser.js';

const AT = '2026-09-04T00:00:00.000Z';

describe('stripAnsi', () => {
  it('removes CSI colour codes, OSC titles, and carriage returns', () => {
    const raw = '\x1b]0;title\x07\x1b[38;2;1;2;3mPlan\x1b[0m\r 2% used';
    expect(stripAnsi(raw)).toBe('Plan 2% used');
  });
});

describe('parsePlanUsage', () => {
  it('parses a full panel with percent, reset, and session lines', () => {
    const text =
      'Plan  ■■■■  2% used • resets in 26 days   25,000 / 10,00,000 AIC\nSession: 12 AIC used';
    expect(parsePlanUsage(text, AT)).toEqual({
      percentUsed: 2,
      usedAic: 25000,
      totalAic: 1000000,
      availableAic: 975000,
      resetInDays: 26,
      sessionAic: 12,
      capturedAt: AT,
    });
  });

  it('tolerates ANSI codes and decimal percentages', () => {
    const text = '\x1b[32mPlan\x1b[0m 12.5% used 125,000 / 1,000,000 AIC';
    const parsed = parsePlanUsage(text, AT);
    expect(parsed?.percentUsed).toBe(12.5);
    expect(parsed?.usedAic).toBe(125000);
    expect(parsed?.totalAic).toBe(1000000);
  });

  it('returns null when the used/total AIC pair is absent', () => {
    expect(parsePlanUsage('Plan 2% used, no numbers here', AT)).toBeNull();
  });

  it('computes percent from the ratio when the CLI omits it', () => {
    const parsed = parsePlanUsage('250,000 / 1,000,000 AIC', AT);
    expect(parsed?.percentUsed).toBe(25);
    expect(parsed?.resetInDays).toBeNull();
    expect(parsed?.sessionAic).toBeNull();
  });

  it('reports zero percent when the total allowance is zero', () => {
    const parsed = parsePlanUsage('0 / 0 AIC', AT);
    expect(parsed?.percentUsed).toBe(0);
    expect(parsed?.availableAic).toBe(0);
  });

  it('clamps available credits to zero when usage exceeds the total', () => {
    const parsed = parsePlanUsage('1,200,000 / 1,000,000 AIC', AT);
    expect(parsed?.availableAic).toBe(0);
  });
});
