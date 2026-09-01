import { describe, it, expect, beforeEach } from 'vitest';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import {
  createAutomationService,
  type AutomationEventMap,
  type AutomationService,
  type CreateAutomationInput,
} from './automation-service.js';
import type {
  Automation,
  AutomationRepo,
  AutomationRun,
} from './automation-contract.js';

function fakeRepo(): AutomationRepo & { store: Map<string, Automation> } {
  const store = new Map<string, Automation>();
  const runs: AutomationRun[] = [];
  return {
    store,
    create(a) {
      store.set(a.id, a);
    },
    get(id) {
      return store.get(id) ?? null;
    },
    list() {
      return [...store.values()];
    },
    save(a) {
      store.set(a.id, a);
    },
    delete(id) {
      store.delete(id);
    },
    appendRun(r) {
      runs.push(r);
    },
    listRuns(id) {
      return runs.filter((r) => r.automationId === id);
    },
  };
}

function counterIds(): { next(): string } {
  let n = 0;
  return {
    next: () => `a${++n}`,
  };
}

const baseInput: CreateAutomationInput = {
  name: 'Watch CI',
  mode: 'long',
  check: { type: 'shell', command: 'echo hi' },
  condition: { type: 'exit-code', equals: 0 },
  action: { type: 'report', prompt: 'summarize' },
};

describe('automation-service', () => {
  let repo: ReturnType<typeof fakeRepo>;
  let bus: ReturnType<typeof createEventBus<AutomationEventMap>>;
  let service: AutomationService;
  let time: number;
  let updated: Automation[];
  let removed: { id: string }[];

  beforeEach(() => {
    repo = fakeRepo();
    bus = createEventBus<AutomationEventMap>();
    time = Date.UTC(2026, 0, 1, 0, 0, 0);
    updated = [];
    removed = [];
    bus.on('automation.updated', (a) => updated.push(a));
    bus.on('automation.removed', (e) => removed.push(e));
    service = createAutomationService({
      repo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 3,
      },
    });
  });

  it('creates an automation with defaults, emits, and schedules next run', () => {
    const a = service.create(baseInput);
    expect(a.id).toBe('a1');
    expect(a.status).toBe('active');
    expect(a.intervalMs).toBe(60_000);
    expect(a.origin).toEqual({ sessionId: null, featureId: null });
    expect(a.plannedSteps).toEqual([]);
    expect(a.maxRuns).toBeNull();
    expect(a.nextRunAt).toBe(new Date(time + 60_000).toISOString());
    expect(updated).toHaveLength(1);
    expect(repo.get('a1')).toEqual(a);
  });

  it('clamps a too-small interval to the floor and keeps a larger one', () => {
    expect(service.create({ ...baseInput, intervalMs: 1_000 }).intervalMs).toBe(
      10_000,
    );
    expect(
      service.create({ ...baseInput, intervalMs: 120_000 }).intervalMs,
    ).toBe(120_000);
  });

  it('honors provided origin, maxRuns and planned steps', () => {
    const a = service.create({
      ...baseInput,
      origin: { sessionId: 's1', featureId: 'f1' },
      maxRuns: 2,
      plannedSteps: [{ id: 'p1', label: 'Detect', status: 'pending', detail: null }],
    });
    expect(a.origin).toEqual({ sessionId: 's1', featureId: 'f1' });
    expect(a.maxRuns).toBe(2);
    expect(a.plannedSteps).toHaveLength(1);
  });

  it('rejects a blank name', () => {
    expect(() => service.create({ ...baseInput, name: '   ' })).toThrow(
      /name is required/,
    );
  });

  it('enforces the active automation cap', () => {
    service.create(baseInput);
    service.create(baseInput);
    service.create(baseInput);
    expect(() => service.create(baseInput)).toThrow(/Too many active/);
  });

  it('get throws when missing and returns when present', () => {
    expect(() => service.get('nope')).toThrow(/not found/);
    const a = service.create(baseInput);
    expect(service.get(a.id)).toEqual(a);
  });

  it('lists all automations', () => {
    service.create(baseInput);
    service.create(baseInput);
    expect(service.list()).toHaveLength(2);
  });

  it('lists runs for an automation and throws for a missing one', () => {
    const a = service.create(baseInput);
    repo.appendRun({
      id: 'r1',
      automationId: a.id,
      startedAt: '2026-01-01T00:00:01.000Z',
      endedAt: null,
      triggered: false,
      status: 'ok',
      detail: null,
      sessionId: null,
    });
    expect(service.listRuns(a.id)).toHaveLength(1);
    expect(() => service.listRuns('missing')).toThrow(/not found/);
  });

  it('save stamps updatedAt and emits', () => {
    const a = service.create(baseInput);
    time += 5_000;
    const saved = service.save({ ...a, progress: 'x' });
    expect(saved.updatedAt).toBe(new Date(time).toISOString());
    expect(saved.progress).toBe('x');
  });

  it('pauses an active automation and rejects pausing a non-active one', () => {
    const a = service.create(baseInput);
    const paused = service.pause(a.id);
    expect(paused.status).toBe('paused');
    expect(paused.nextRunAt).toBeNull();
    expect(() => service.pause(a.id)).toThrow(/not active/);
  });

  it('resumes a paused automation and rejects resuming a non-paused one', () => {
    const a = service.create(baseInput);
    expect(() => service.resume(a.id)).toThrow(/not paused/);
    service.pause(a.id);
    const resumed = service.resume(a.id);
    expect(resumed.status).toBe('active');
    expect(resumed.failure).toBeNull();
    expect(resumed.nextRunAt).toBe(new Date(time + 60_000).toISOString());
  });

  it('resumes a needs-auth automation once the user has signed in', () => {
    const a = service.create(baseInput);
    service.save({
      ...service.get(a.id),
      status: 'needs-auth',
      nextRunAt: null,
      failure: 'Authentication required',
    });
    const resumed = service.resume(a.id);
    expect(resumed.status).toBe('active');
    expect(resumed.failure).toBeNull();
    expect(resumed.nextRunAt).toBe(new Date(time + 60_000).toISOString());
  });

  it('cancels an automation and rejects cancelling a finished one', () => {
    const a = service.create(baseInput);
    const cancelled = service.cancel(a.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.nextRunAt).toBeNull();
    expect(() => service.cancel(a.id)).toThrow(/already finished/);
  });

  it('runNow makes the automation due immediately and reactivates it', () => {
    const a = service.create(baseInput);
    service.pause(a.id);
    const ran = service.runNow(a.id);
    expect(ran.status).toBe('active');
    expect(ran.nextRunAt).toBe(new Date(time).toISOString());
  });

  it('runNow rejects a finished automation', () => {
    const a = service.create(baseInput);
    service.cancel(a.id);
    expect(() => service.runNow(a.id)).toThrow(/already finished/);
  });

  it('removes an automation and emits removed', () => {
    const a = service.create(baseInput);
    service.remove(a.id);
    expect(repo.get(a.id)).toBeNull();
    expect(removed).toEqual([{ id: a.id }]);
    expect(() => service.remove(a.id)).toThrow(/not found/);
  });

  it('updates progress and planned steps', () => {
    const a = service.create(baseInput);
    expect(service.updateProgress(a.id, 'halfway').progress).toBe('halfway');
    const steps = [{ id: 'p1', label: 'Go', status: 'active' as const, detail: null }];
    expect(service.setPlannedSteps(a.id, steps).plannedSteps).toEqual(steps);
  });

  it('updateInterval clamps and reschedules an active monitor', () => {
    const a = service.create(baseInput);
    time += 5_000;
    const updatedInterval = service.updateInterval(a.id, 120_000);
    expect(updatedInterval.intervalMs).toBe(120_000);
    expect(updatedInterval.nextRunAt).toBe(new Date(time + 120_000).toISOString());
  });

  it('updateInterval clamps a too-small interval to the floor', () => {
    const a = service.create(baseInput);
    expect(service.updateInterval(a.id, 1_000).intervalMs).toBe(10_000);
  });

  it('updateInterval keeps the paused next-run untouched', () => {
    const a = service.create(baseInput);
    const paused = service.pause(a.id);
    expect(paused.nextRunAt).toBeNull();
    const changed = service.updateInterval(a.id, 30_000);
    expect(changed.intervalMs).toBe(30_000);
    expect(changed.nextRunAt).toBeNull();
  });

  it('updateInterval rejects a finished monitor', () => {
    const a = service.create(baseInput);
    service.cancel(a.id);
    expect(() => service.updateInterval(a.id, 30_000)).toThrow(
      /already finished/,
    );
  });
});
