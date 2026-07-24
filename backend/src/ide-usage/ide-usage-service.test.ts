import { describe, it, expect } from 'vitest';
import { createIdeUsageService } from './ide-usage-service.js';
import type { IdeUsageReader } from './ide-usage-contract.js';
import type {
  DailyBreakdown,
  ModelBreakdown,
  UsageTotals,
} from '../aggregation/aggregation-contract.js';

const totals: UsageTotals = {
  sessions: 2,
  inputTokens: 150,
  outputTokens: 40,
  reasoningOutputTokens: 10,
  cost: 9,
  credits: 9,
  nanoAiu: 9000,
};

const byModel: ModelBreakdown[] = [{ model: 'auto', ...totals }];
const byDay: DailyBreakdown[] = [{ day: '2025-02-01', ...totals }];

function fakeReader(): IdeUsageReader {
  return {
    totals: () => totals,
    byModel: () => byModel,
    byDay: () => byDay,
  };
}

describe('ide-usage-service', () => {
  it('assembles the IDE usage payload from the reader', () => {
    const service = createIdeUsageService({ reader: fakeReader() });
    expect(service.read()).toEqual({ totals, byModel, byDay });
  });
});
