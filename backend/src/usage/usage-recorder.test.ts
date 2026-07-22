import { describe, it, expect } from 'vitest';
import { createUsageRecorder, type UsageRecordedMap } from './usage-recorder.js';
import { createCreditCalculator } from '../credit/credit-calculator.js';
import { createBuiltinCreditStrategies } from '../credit/credit-strategies.js';
import { creditDefaults } from '../credit/config.js';
import { createEventBus } from '../kernel/event-bus.js';
import type { StoredUsage } from './usage-repo-port.js';
import type { UsageEvent } from './usage-contract.js';

function usage(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    sessionId: 's1',
    featureId: 'f1',
    turnIndex: 0,
    provider: 'github',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4-mini',
    operation: 'chat',
    inputTokens: 100,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    cost: 0.33,
    nanoAiu: 1000,
    serviceRequestId: 'req',
    startedAt: '2025-01-01T00:00:02.000Z',
    endedAt: '2025-01-01T00:00:03.000Z',
    ...overrides,
  };
}

function harness() {
  const saved: StoredUsage[][] = [];
  const emitted: StoredUsage[] = [];
  const calculator = createCreditCalculator(
    createBuiltinCreditStrategies(creditDefaults),
    { activeStrategy: creditDefaults.activeStrategy, unit: creditDefaults.unit },
  );
  const bus = createEventBus<UsageRecordedMap>();
  bus.on('usage.recorded', (e) => emitted.push(e));
  const recorder = createUsageRecorder({
    calculator,
    repo: {
      saveAll: (e) => saved.push(e),
      listBySession: () => [],
      deleteBySession: () => undefined,
    },
    bus,
  });
  return { recorder, saved, emitted };
}

describe('usage-recorder', () => {
  it('credits, persists and emits a single usage event', () => {
    const h = harness();
    const stored = h.recorder.record(usage({ cost: 0.33 }), 'dev');
    expect(stored.credits).toBeCloseTo(0.33);
    expect(stored.kind).toBe('dev');
    expect(h.saved).toEqual([[stored]]);
    expect(h.emitted).toEqual([stored]);
  });

  it('records a batch of events and tags the kind', () => {
    const h = harness();
    const stored = h.recorder.recordAll(
      [usage({ turnIndex: 0, cost: 0.33 }), usage({ turnIndex: 1, cost: 1 })],
      'meta',
    );
    expect(stored.map((s) => s.credits)).toEqual([0.33, 1]);
    expect(stored.every((s) => s.kind === 'meta')).toBe(true);
    expect(h.emitted).toHaveLength(2);
  });
});
