import { describe, expect, it, vi } from 'vitest';
import { createClock } from '../kernel/clock.js';
import { createEventBus } from '../kernel/event-bus.js';
import {
  createSubagentReconciler,
  INTERRUPTED_SUBAGENT_MESSAGE,
} from './subagent-reconciler.js';
import type { Subagent, SubagentRepo } from './automation-contract.js';
import type { SubagentEventMap } from './subagent-service.js';

function subagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 'g1',
    automationId: 'a1',
    origin: { sessionId: 's1', featureId: 'f1' },
    task: 'Investigate',
    status: 'running',
    progress: null,
    result: null,
    sessionId: 'm1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function repo(initial: Subagent[]): SubagentRepo {
  const store = new Map(initial.map((item) => [item.id, item]));
  return {
    create: () => {},
    get: (id) => store.get(id) ?? null,
    list: () => [...store.values()],
    save: (next) => {
      store.set(next.id, next);
    },
    listByAutomation: (automationId) =>
      [...store.values()].filter((item) => item.automationId === automationId),
    deleteByAutomation: () => {},
    deleteByOriginFeature: () => {},
    deleteByOriginSession: () => {},
  };
}

describe('createSubagentReconciler', () => {
  it('fails queued and running subagents left behind by a restart', () => {
    const bus = createEventBus<SubagentEventMap>();
    const updated = vi.fn();
    bus.on('subagent.updated', updated);
    const items = repo([
      subagent({ id: 'queued', status: 'queued', result: null }),
      subagent({ id: 'running', status: 'running', result: 'partial' }),
      subagent({ id: 'done', status: 'done', result: 'ok' }),
    ]);

    const count = createSubagentReconciler({
      repo: items,
      clock: createClock(() => Date.parse('2026-02-02T00:00:00.000Z')),
      bus,
    }).reconcileOrphans();

    expect(count).toBe(2);
    expect(items.get('queued')).toMatchObject({
      status: 'failed',
      result: INTERRUPTED_SUBAGENT_MESSAGE,
      updatedAt: '2026-02-02T00:00:00.000Z',
    });
    expect(items.get('running')).toMatchObject({
      status: 'failed',
      result: 'partial',
      updatedAt: '2026-02-02T00:00:00.000Z',
    });
    expect(items.get('done')).toMatchObject({ status: 'done', result: 'ok' });
    expect(updated).toHaveBeenCalledTimes(2);
  });
});
