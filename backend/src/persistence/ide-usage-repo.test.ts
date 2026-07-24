import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createUsageRepo } from './usage-repo.js';
import { createIdeUsageRepo } from './ide-usage-repo.js';
import { ideUsageDefaults } from '../ide-usage/config.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

function usage(overrides: Partial<StoredUsage>): StoredUsage {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.33,
    credits: 0.33,
    nanoAiu: 1000,
    serviceRequestId: 'req',
    startedAt: '2025-01-01T00:00:02.000Z',
    endedAt: '2025-01-01T00:00:03.000Z',
    ...overrides,
  };
}

function seed() {
  const db = createDatabase({ databasePath: ':memory:' });
  const repo = createUsageRepo(db);
  repo.saveAll([
    // dev usage — must be excluded from IDE (meta) totals.
    usage({ sessionId: 's1', turnIndex: 0, credits: 5, inputTokens: 100 }),
    // meta usage across two sessions, two models, two days.
    usage({
      sessionId: 'm1',
      turnIndex: 0,
      kind: 'meta',
      resolvedModel: 'auto',
      credits: 2,
      inputTokens: 50,
      nanoAiu: 2000,
      startedAt: '2025-02-01T00:00:00.000Z',
    }),
    usage({
      sessionId: 'm1',
      turnIndex: 1,
      kind: 'meta',
      resolvedModel: 'gpt-5.4-mini',
      credits: 3,
      inputTokens: 70,
      nanoAiu: 3000,
      startedAt: '2025-02-01T00:05:00.000Z',
    }),
    usage({
      sessionId: 'm2',
      turnIndex: 0,
      kind: 'meta',
      resolvedModel: 'auto',
      credits: 4,
      inputTokens: 30,
      nanoAiu: 4000,
      startedAt: '2025-02-02T00:00:00.000Z',
    }),
  ]);
  return { db, reader: createIdeUsageRepo(db, ideUsageDefaults) };
}

describe('ide-usage-repo', () => {
  it('totals only meta-kind usage across sessions', () => {
    const { db, reader } = seed();
    const totals = reader.totals();
    expect(totals.sessions).toBe(2);
    expect(totals.credits).toBeCloseTo(2 + 3 + 4);
    expect(totals.inputTokens).toBe(150);
    expect(totals.nanoAiu).toBe(9000);
    db.close();
  });

  it('breaks meta usage down by model', () => {
    const { db, reader } = seed();
    const byModel = reader.byModel();
    expect(byModel.map((m) => m.model)).toEqual(['auto', 'gpt-5.4-mini']);
    expect(byModel[0].credits).toBeCloseTo(2 + 4);
    db.close();
  });

  it('breaks meta usage down by day', () => {
    const { db, reader } = seed();
    const byDay = reader.byDay();
    expect(byDay.map((d) => d.day)).toEqual(['2025-02-01', '2025-02-02']);
    expect(byDay[0].credits).toBeCloseTo(2 + 3);
    db.close();
  });

  it('returns empty totals when there is no meta usage', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createUsageRepo(db);
    repo.saveAll([usage({ sessionId: 'd1', kind: 'dev' })]);
    const reader = createIdeUsageRepo(db, ideUsageDefaults);
    expect(reader.totals().sessions).toBe(0);
    expect(reader.totals().credits).toBe(0);
    expect(reader.byModel()).toEqual([]);
    expect(reader.byDay()).toEqual([]);
    db.close();
  });
});
