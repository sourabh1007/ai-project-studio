import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { aggregationDefaults } from '../aggregation/config.js';
import { createFeatureAnalytics } from '../aggregation/feature-analytics.js';
import { createAggregateRepo } from '../persistence/aggregate-repo.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createFeatureRepo } from '../persistence/feature-repo.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createSessionRepo } from '../persistence/session-repo.js';
import { createUsageCaptureRepo } from '../persistence/usage-capture-repo.js';
import { createUsageRepo } from '../persistence/usage-repo.js';
import { createClock } from '../kernel/clock.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createRecordingMetaRunner } from '../meta/recording-meta-runner.js';
import { createMetaOperationOwnership } from '../meta/meta-operation-ownership.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { StreamEventMap } from '../api/usage-stream.js';
import { subscribeStream } from '../api/usage-stream.js';
import { createBuiltinCreditStrategies } from '../credit/credit-strategies.js';
import { createCreditCalculator } from '../credit/credit-calculator.js';
import { creditDefaults } from '../credit/config.js';
import { createCliUsageTailer } from '../usage/cli-usage-tailer.js';
import type { UsageEvent } from '../usage/usage-contract.js';
import { createUsageRecorder } from '../usage/usage-recorder.js';
import { createUsageDetailService } from '../usage-detail/usage-detail-service.js';
import type { Session } from '../session/session-contract.js';
import { createIdGenerator } from '../kernel/id-generator.js';

const timestamp = '2026-09-10T06:30:00.000Z';

function createSession(id: string, featureId: string): Session {
  return {
    id,
    featureId,
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5',
    status: 'completed',
    kind: 'dev',
    scope: 'feature',
    groupId: null,
    orderIndex: 0,
    prompt: 'Implement the feature',
    usageFilePath: `usage/${id}.jsonl`,
    createdAt: timestamp,
    startedAt: timestamp,
    endedAt: '2026-09-10T06:31:00.000Z',
    exitCode: 0,
  };
}

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 'session-1',
    featureId: 'feature-1',
    turnIndex: 99,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 40,
    reasoningOutputTokens: 5,
    cost: 0.75,
    nanoAiu: 1_000_000,
    serviceRequestId: 'request-1',
    startedAt: timestamp,
    endedAt: '2026-09-10T06:30:01.000Z',
    ...overrides,
  };
}

describe('usage and meta persistence integration', () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('normalizes captured usage, credits and persists it, aggregates detail, and forwards SSE', () => {
    db = createDatabase({ databasePath: ':memory:' });
    const features = createFeatureRepo(db);
    const sessions = createSessionRepo(db);
    const usage = createUsageRepo(db);
    const captures = createUsageCaptureRepo(db);
    features.create({
      id: 'feature-1',
      name: 'Usage feature',
      description: 'Usage integration',
      createdAt: timestamp,
      summary: null,
      repoId: null,
      checkoutPath: null,
      parentFeatureId: null,
      orderIndex: 0,
    });
    sessions.save(createSession('session-1', 'feature-1'));

    const bus = createEventBus<StreamEventMap>();
    const forwarded: Array<{ event: string; data: unknown }> = [];
    const unsubscribe = subscribeStream(bus, {
      send: (event, data) => forwarded.push({ event, data }),
    });
    const calculator = createCreditCalculator(
      createBuiltinCreditStrategies({
        ...creditDefaults,
        providerCost: { multiplier: 2 },
      }),
      { activeStrategy: 'provider-cost', unit: 'credits' },
    );
    const recorder = createUsageRecorder({
      calculator,
      repo: usage,
      bus: bus as unknown as Parameters<typeof createUsageRecorder>[0]['bus'],
    });

    let reads = 0;
    const tailer = createCliUsageTailer({
      sessionId: 'session-1',
      sourceId: 'otel-file',
      read: () => {
        reads += 1;
        return {
          status: 'ready' as const,
          sourceId: 'otel-file',
          rows: reads === 1 ? [{ sourceKey: 'provider-turn-1', event: usageEvent() }] : [],
          nextCursor: null,
          final: true,
        };
      },
      recorder,
      captures,
      kind: 'dev',
      intervalMs: 1000,
      pageSize: 10,
      finalDrainPages: 8,
    });

    expect(tailer.finalize()).toMatchObject({ status: 'complete', sourceDone: true });
    const stored = usage.listBySession('session-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      turnIndex: 0,
      credits: 1.5,
      inputTokens: 100,
      outputTokens: 40,
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      event: 'usage.recorded',
      data: expect.objectContaining({ turnIndex: 0, credits: 1.5 }),
    });

    const analytics = createFeatureAnalytics({
      reader: createAggregateRepo(db, aggregationDefaults),
      sessions,
      groups: { listByFeature: () => [] },
      clock: createClock(() => Date.parse('2026-09-10T06:32:00.000Z')),
    });
    expect(analytics.forFeature('feature-1')).toMatchObject({
      totals: {
        sessions: 1,
        inputTokens: 100,
        outputTokens: 40,
        credits: 1.5,
      },
      byModel: [{ model: 'gpt-5', credits: 1.5 }],
      byProvider: [{ provider: 'copilot', credits: 1.5 }],
      byDay: [{ day: '2026-09-10', credits: 1.5 }],
      bySession: [{ sessionId: 'session-1', credits: 1.5 }],
    });

    const detail = createUsageDetailService({
      usage,
      sessions,
      features,
    });
    expect(detail.forFeature('feature-1')).toEqual(stored);
    unsubscribe();
  });

  it('records one meta operation through completion and reads its persisted result', async () => {
    db = createDatabase({ databasePath: ':memory:' });
    const operations = createMetaOperationRepo(db);
    const clock = createClock(() => Date.parse(timestamp));
    const base: MetaRunner = {
      run: async () => 'unused',
      runDetailed: async (request) => {
        request.onStart?.('provider-session-1');
        return {
          text: 'deterministic meta result',
          sessionId: 'provider-session-1',
          providerId: 'fake-provider',
          requestedModel: 'fake-model',
          resolvedModel: 'fake-model',
          transport: 'session',
          usage: {
            inputTokens: 12,
            outputTokens: 7,
            nanoAiu: 3_000_000,
            credits: 0.25,
          },
        };
      },
    };
    const runner = createRecordingMetaRunner({
      base,
      operations,
      ownership: createMetaOperationOwnership(),
      clock,
      newOperationId: createIdGenerator(() => 'operation-1').next,
      resolveIdentity: () => ({
        providerId: 'fake-provider',
        requestedModel: 'fake-model',
      }),
    });

    const result = await runner.runDetailed({
      featureId: 'feature-1',
      prompt: 'summarize the feature',
      scope: 'internal',
      purpose: 'integration',
      label: 'Saved operation',
    });

    expect(result.operationId).toBe('operation-1');
    expect(operations.get('operation-1')).toMatchObject({
      operationId: 'operation-1',
      state: 'completed',
      outcome: 'returned',
      sessionId: 'provider-session-1',
      resultText: 'deterministic meta result',
      usageState: 'recorded',
      usage: { inputTokens: 12, outputTokens: 7, credits: 0.25 },
    });
    expect(operations.listPage({ featureId: 'feature-1' }, null, 10).items).toMatchObject([
      {
        operationId: 'operation-1',
        state: 'completed',
        hasResult: true,
      },
    ]);
  });
});
