import { describe, expect, it } from 'vitest';
import { createProviderUsageReader, type ProviderUsageSample } from './provider-usage-reader.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createUsageRepo } from '../persistence/usage-repo.js';
import { createUsageCaptureRepo } from '../persistence/usage-capture-repo.js';
import { createAggregateRepo } from '../persistence/aggregate-repo.js';
import { createUsageRollupRepo } from '../persistence/usage-rollup-repo.js';
import { createIdeUsageRepo } from '../persistence/ide-usage-repo.js';
import { createRetainedUsageRepo } from '../persistence/retained-usage-repo.js';
import { aggregationDefaults } from '../aggregation/config.js';
import { ideUsageDefaults } from '../ide-usage/config.js';
import { createCreditCalculator } from '../credit/credit-calculator.js';
import { createBuiltinCreditStrategies } from '../credit/credit-strategies.js';
import { creditDefaults } from '../credit/config.js';
import { createUsageRecorder } from './usage-recorder.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createCliUsageTailer } from './cli-usage-tailer.js';
import { rollupUsage } from '../usage-rollup/usage-rollup-service.js';
import { createMetaUsageReader } from '../pr-review/meta-usage-reader.js';

const sample = (overrides: Partial<ProviderUsageSample> = {}): ProviderUsageSample => ({
  nativeSessionId: 'native', nativeMessageId: 'message', scope: 'message', model: 'sonnet',
  inputTokens: 100, outputTokens: 20, charge: { status: 'unavailable' }, ...overrides,
});
const session = { id: 's', featureId: 'f', requestedModel: 'sonnet', createdAt: '2026-01-01T00:00:00Z' };

describe('provider-neutral native usage capture', () => {
  it('preserves cache append watermarks at EOF without inventing one for legacy pages', () => {
    let highWaterCursor: string | null | undefined = 'opaque:7';
    const read = createProviderUsageReader({
      provider: 'claude', sourceId: 'cache', session,
      readPage: () => ({ samples: [], nextCursor: null, highWaterCursor }),
    });
    expect(read('opaque:7', 128)).toMatchObject({
      status: 'ready', nextCursor: null, highWaterCursor: 'opaque:7', rows: [],
    });
    highWaterCursor = null;
    expect(read(null, 128)).toMatchObject({ status: 'ready', highWaterCursor: null });
    highWaterCursor = undefined;
    const result = read('legacy-position', 128);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.highWaterCursor).toBeUndefined();
  });
  it('counts disjoint uncached, cache-read and cache-write input once, excluding cumulative session usage', () => {
    const read = createProviderUsageReader({
      provider: 'claude', sourceId: 'cache', session,
      readPage: () => ({ nextCursor: null, samples: [
        sample({ cacheReadTokens: 30, cacheWriteTokens: 20 }),
        sample({ nativeMessageId: 'zero', inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        sample({ nativeMessageId: 'unreported-cache', cacheReadTokens: null, cacheWriteTokens: null }),
        sample({ scope: 'session', inputTokens: 10_000, cacheReadTokens: 20_000, cacheWriteTokens: 30_000,
          charge: { status: 'estimated', unit: 'USD', amount: 4, scope: 'session' } }),
      ] }),
    });
    const result = read(null, 4);
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.rows.map(({ event }) => event.inputTokens)).toEqual([150, 0, 100, 0]);
    expect(result.rows.every(({ event }) => event.cost === null && event.nanoAiu === null)).toBe(true);
  });
  it('reports missing caches honestly and excludes incomplete observations without inventing usage', () => {
    const unavailable = createProviderUsageReader({ provider: 'claude', sourceId: 'cache', session, readPage: () => null });
    expect(unavailable(null, 1)).toMatchObject({ status: 'retrying', reason: 'provider-cache-unavailable' });
    const reader = createProviderUsageReader({
      provider: 'claude', sourceId: 'cache', session,
      readPage: () => ({ nextCursor: 'next', samples: [
        sample({ scope: 'session' }), sample({ inputTokens: null }), sample({ outputTokens: null }),
        sample({ model: null }), sample({ scope: 'session', charge: { status: 'estimated', unit: 'USD', amount: 0, scope: 'session' } }),
      ] }),
    });
    expect(reader(null, 5)).toMatchObject({ status: 'ready', nextCursor: 'next', final: false, rows: [
      { event: { resolvedModel: 'sonnet', inputTokens: 100, cost: null, nanoAiu: null, usdEstimate: null, chargeProvenance: 'unavailable' } },
      { event: { operation: 'session-charge-estimate', inputTokens: 0, outputTokens: 0, usdEstimate: 0, chargeProvenance: 'estimated' } },
    ] });
  });

  it('deduplicates resume/subagent samples, replaces cumulative USD, captures late corrections and preserves unknown totals', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const usage = createUsageRepo(db);
    const captures = createUsageCaptureRepo(db);
    const recorder = createUsageRecorder({
      calculator: createCreditCalculator(createBuiltinCreditStrategies(creditDefaults), { activeStrategy: 'provider-cost', unit: 'credits' }),
      repo: usage, bus: createEventBus(),
    });
    let samples = [
      sample({ cacheReadTokens: 20, cacheWriteTokens: 10 }), sample({ cacheReadTokens: 20, cacheWriteTokens: 10 }),
      sample({ nativeSessionId: 'subagent', nativeMessageId: 'message', inputTokens: 5 }),
      sample({ scope: 'session', charge: { status: 'estimated', unit: 'USD', amount: 2, scope: 'session' } }),
    ];
    const read = createProviderUsageReader({ provider: 'claude', sourceId: 'cache', session,
      readPage: () => ({ samples, nextCursor: null }) });
    const tailer = createCliUsageTailer({
      sessionId: 's', sourceId: 'cache', read, recorder, captures,
      kind: 'meta', intervalMs: 1000, pageSize: 10, finalDrainPages: 2,
    });
    tailer.finalize();
    expect(usage.listBySession('s')).toHaveLength(3);
    samples = [
      sample({ outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 20 }),
      sample({ scope: 'session', nativeMessageId: 'new-result-uuid', charge: { status: 'estimated', unit: 'USD', amount: 3, scope: 'session' } }),
    ];
    tailer.finalize();
    const stored = usage.listBySession('s');
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ outputTokens: 40, cost: null, credits: null, nanoAiu: null, nativeMessageId: 'message', chargeUnit: null });
    expect(stored[2]).toMatchObject({ inputTokens: 0, usdEstimate: 3 });
    const aggregate = createAggregateRepo(db, aggregationDefaults);
    expect(aggregate.featureTotals('f')).toMatchObject({
      inputTokens: 155, outputTokens: 60, cost: null, credits: null, nanoAiu: null, usdEstimate: 3,
      knownCost: 0, knownCredits: 0, knownNanoAiu: 0, unavailableCharges: 3,
    });
    expect(aggregate.byModel('f')[0].credits).toBeNull();
    expect(aggregate.byProvider('f')[0].nanoAiu).toBeNull();
    expect(aggregate.byDay('f')[0].cost).toBeNull();
    expect(aggregate.bySession('f')[0].usdEstimate).toBe(3);
    const ide = createIdeUsageRepo(db, ideUsageDefaults);
    expect(ide.totals().credits).toBeNull();
    expect(ide.byModel()[0].nanoAiu).toBeNull();
    expect(ide.byDay()[0].cost).toBeNull();
    expect(createMetaUsageReader({ usage }).usageForSession('s')).toMatchObject({ nanoAiu: null, credits: null, inputTokens: 155 });
    const rolls = createUsageRollupRepo(db, ideUsageDefaults);
    const days = rolls.ideDays();
    expect(days[0]).toMatchObject({ credits: null, cost: null, nanoAiu: null, usdEstimate: 3 });
    expect(rollupUsage([...days, ...days], 'day', 'ide').totals).toMatchObject({ nanoAiu: null, usdEstimate: 6 });
    createRetainedUsageRepo(db).summarizeSession({
      sessionId: 's', featureId: 'f', featureName: 'Feature', sessionKind: 'meta', scope: 'internal',
      reason: 'session-deleted', retainedAt: session.createdAt,
    });
    const retained = db.prepare('SELECT * FROM retained_usage').get() as Record<string, unknown>;
    expect(retained).toMatchObject({ cost: null, credits: null, nano_aiu: null, usd_estimate: 3 });
    usage.deleteBySession('s');
    expect(rolls.ideDays()[0]).toMatchObject({ nanoAiu: null, usdEstimate: 3 });
    db.close();
  });

  it('keeps source attribution immutable and prevents provider/native key collisions', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createUsageRepo(db);
    const ledger = createUsageCaptureRepo(db);
    const result = createProviderUsageReader({ provider: 'claude', sourceId: 'cache', session,
      readPage: () => ({ samples: [sample()], nextCursor: null }) })(null, 1);
    if (result.status !== 'ready') throw new Error('expected ready');
    const event = result.rows[0].event;
    const reserved = ledger.reserve('s', 'key', event);
    ledger.reserve('s', 'key', { ...event, outputTokens: 99 });
    for (const changed of [
      { provider: 'copilot' }, { featureId: 'other' }, { nativeSessionId: 'other' }, { nativeMessageId: 'other' },
    ]) {
      expect(() => ledger.reserve('s', 'key', { ...event, ...changed })).toThrow('source-attribution-mismatch');
    }
    expect(() => ledger.reserve('other', 'key', event)).toThrow('source-session-mismatch');
    repo.saveAll([{ ...reserved.event, credits: null, kind: 'dev' }]);
    expect(() => repo.saveAll([{ ...reserved.event, provider: 'copilot', credits: 9, kind: 'dev' }])).toThrow('immutable');
    expect(() => repo.saveAll([{ ...reserved.event, sessionId: 'duplicate', credits: null, kind: 'dev' }])).toThrow('UNIQUE');
    expect(repo.get('s', reserved.turnIndex)?.provider).toBe('claude');
    db.close();
  });
});
