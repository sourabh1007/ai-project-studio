import { describe, it, expect, vi } from 'vitest';
import { createAutomationRoutes } from './automation-controller.js';
import { createAutomationScheduler } from '../automation/automation-scheduler.js';
import type { AutomationService } from '../automation/automation-service.js';
import {
  createAutomationService,
  type AutomationEventMap,
} from '../automation/automation-service.js';
import type { SubagentService } from '../automation/subagent-service.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import { ConflictError } from '../kernel/error-types.js';
import { createAutomationRepo } from '../persistence/automation-repo.js';
import { createDatabase } from '../persistence/db/connection.js';
import type {
  ActionRunner,
  Automation,
  AutomationRun,
  CheckResult,
  CheckRunner,
} from '../automation/automation-contract.js';
import type { Route } from './http-contract.js';

function routeMap(routes: Route[]): Map<string, Route> {
  return new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

const sampleBody = {
  name: 'Watch CI',
  mode: 'long',
  check: { type: 'shell', command: 'echo' },
  condition: { type: 'exit-code', equals: 0 },
  action: { type: 'report', prompt: 'go' },
};

function services() {
  const automations = {
    list: vi.fn(() => ['A']),
    get: vi.fn(() => 'one'),
    listRuns: vi.fn(() => ['run']),
    create: vi.fn((input) => ({ created: input })),
    pause: vi.fn(() => 'paused'),
    resume: vi.fn(() => 'resumed'),
    cancel: vi.fn(() => 'cancelled'),
    runNow: vi.fn(() => 'ran'),
    updateProgress: vi.fn(() => 'automation-progress'),
    setPlannedSteps: vi.fn(() => 'planned'),
    updateInterval: vi.fn(() => 'interval-updated'),
    remove: vi.fn(),
  } as unknown as AutomationService & Record<string, ReturnType<typeof vi.fn>>;
  const subagents = {
    list: vi.fn(() => ['G']),
    listByAutomation: vi.fn(() => ['g1']),
    register: vi.fn(() => 'registered'),
    updateProgress: vi.fn(() => 'subagent-progress'),
    complete: vi.fn(() => 'completed'),
    fail: vi.fn(() => 'failed'),
  } as unknown as SubagentService & Record<string, ReturnType<typeof vi.fn>>;
  return { automations, subagents };
}

function counterIds() {
  let n = 0;
  return { next: () => `id${++n}` };
}

function realRouteHarness({
  checks,
  actions,
}: {
  checks: CheckRunner;
  actions: ActionRunner;
}) {
  let time = Date.UTC(2026, 0, 1);
  const clock = createClock(() => time);
  const db = createDatabase({ databasePath: ':memory:' });
  const repo = createAutomationRepo(db);
  const bus = createEventBus<AutomationEventMap>();
  const ids = counterIds();
  const automations = createAutomationService({
    repo,
    clock,
    ids,
    bus,
    config: {
      defaultIntervalMs: 60_000,
      minIntervalMs: 10_000,
      maxActiveAutomations: 50,
    },
  });
  const scheduler = createAutomationScheduler({
    repo,
    checks,
    actions,
    clock,
    ids: counterIds(),
    bus,
    config: {
      minIntervalMs: 10_000,
      maxConcurrentChecks: 1,
    },
  });
  const subagents = services().subagents;
  const routes = routeMap(
    createAutomationRoutes({ automations, subagents, scheduler }),
  );
  const due = (name: string): Automation =>
    automations.runNow(
      automations.create({
        name,
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
  const uncertain = (
    automation: Automation,
    overrides: Partial<AutomationRun> = {},
  ): AutomationRun => ({
    id: `uncertain-${automation.id}`,
    automationId: automation.id,
    source: 'scheduled',
    phase: 'uncertain',
    scheduledForAt: automation.nextRunAt,
    occurrenceKey: 'run-b',
    dedupeKey: `scheduled:${automation.id}:uncertain`,
    startedAt: new Date(time).toISOString(),
    dispatchedAt: new Date(time).toISOString(),
    endedAt: new Date(time).toISOString(),
    triggered: true,
    status: 'failed',
    detail:
      'Previous action may have already run for occurrence "run-b". Automatic retries are blocked until you explicitly choose Run now.',
    sessionId: null,
    acknowledgedRunIds: null,
    acknowledgedSnapshotRunIds: null,
    resolvedByRunId: null,
    ...overrides,
  });
  return {
    db,
    repo,
    routes,
    scheduler,
    due,
    uncertain,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe('createAutomationRoutes', () => {
  it('lists automations and subagents', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('get /automations')!.handler({
      params: {},
      query: {},
      body: undefined,
    });
    expect(res).toEqual({
      status: 200,
      body: { automations: ['A'], subagents: ['G'] },
    });
  });

  it('reads one automation with its runs and subagents', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('get /automations/:id')!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      automation: 'one',
      runs: ['run'],
      subagents: ['g1'],
    });
    expect(automations.get).toHaveBeenCalledWith('a1');
    expect(subagents.listByAutomation).toHaveBeenCalledWith('a1');
  });

  it('creates an automation from a validated body', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('post /automations')!.handler({
      params: {},
      query: {},
      body: sampleBody,
    });
    expect(res.status).toBe(201);
    expect(automations.create).toHaveBeenCalledTimes(1);
  });

  it('requires the control token when configured', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(
      createAutomationRoutes({
        automations,
        subagents,
        controlToken: 'secret',
      }),
    );
    await expect(
      routes.get('post /automations')!.handler({
        params: {},
        query: {},
        body: sampleBody,
      }),
    ).rejects.toThrow(/control token/);
    const res = await routes.get('post /automations')!.handler({
      params: {},
      query: {},
      headers: { 'x-studio-control-token': 'secret' },
      body: sampleBody,
    });
    expect(res.status).toBe(201);
  });

  it('rejects an invalid create body', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    await expect(
      routes.get('post /automations')!.handler({
        params: {},
        query: {},
        body: { name: '' },
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['post /automations/:id/pause', 'pause'],
    ['post /automations/:id/resume', 'resume'],
    ['post /automations/:id/cancel', 'cancel'],
    ['post /automations/:id/run', 'runNow'],
  ])('drives lifecycle route %s', async (signature, method) => {
    const { automations, subagents } = services();
    const scheduler = {
      abort: vi.fn(),
      kick: vi.fn(async () => {}),
      runNow: vi.fn(async () => 'queued'),
    } as any;
    const routes = routeMap(
      createAutomationRoutes({ automations, subagents, scheduler }),
    );
    const res = await routes.get(signature)!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });
    expect(res.status).toBe(200);
    if (method === 'pause' || method === 'cancel') {
      expect(automations[method]).toHaveBeenCalledWith('a1');
      expect(scheduler.abort).toHaveBeenCalledWith('a1');
    } else if (method === 'runNow') {
      expect(scheduler.runNow).toHaveBeenCalledWith('a1', {
        acknowledgement: null,
      });
      expect(automations.runNow).not.toHaveBeenCalled();
    } else {
      expect(automations[method]).toHaveBeenCalledWith('a1');
      expect(scheduler.abort).not.toHaveBeenCalled();
      expect(scheduler.kick).not.toHaveBeenCalled();
    }
  });

  it('updates the poll interval and reschedules', async () => {
    const { automations, subagents } = services();
    const scheduler = { abort: vi.fn(), kick: vi.fn(async () => {}) } as any;
    const routes = routeMap(
      createAutomationRoutes({ automations, subagents, scheduler }),
    );
    const res = await routes.get('post /automations/:id/interval')!.handler({
      params: { id: 'a1' },
      query: {},
      body: { intervalMs: 120_000 },
    });
    expect(res).toEqual({ status: 200, body: 'interval-updated' });
    expect(automations.updateInterval).toHaveBeenCalledWith('a1', 120_000);
    expect(scheduler.kick).toHaveBeenCalledWith('a1');
  });

  it('returns the latest automation snapshot after a run-now enqueue', async () => {
    const { automations, subagents } = services();
    const scheduler = {
      abort: vi.fn(),
      kick: vi.fn(async () => {}),
      runNow: vi.fn(async () => 'queued'),
    } as any;
    const routes = routeMap(
      createAutomationRoutes({ automations, subagents, scheduler }),
    );

    const res = await routes.get('post /automations/:id/run')!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });

    expect(scheduler.runNow).toHaveBeenCalledWith('a1', {
      acknowledgement: null,
    });
    expect(automations.runNow).not.toHaveBeenCalled();
    expect(automations.get).not.toHaveBeenCalled();
    expect(res).toEqual({ status: 200, body: 'queued' });
  });

  it('forwards an explicit uncertainty acknowledgement to scheduler run-now', async () => {
    const { automations, subagents } = services();
    const scheduler = {
      abort: vi.fn(),
      kick: vi.fn(async () => {}),
      runNow: vi.fn(async () => 'queued'),
    } as any;
    const routes = routeMap(
      createAutomationRoutes({ automations, subagents, scheduler }),
    );

    await routes.get('post /automations/:id/run')!.handler({
      params: { id: 'a1' },
      query: {},
      body: {
        uncertaintyAcknowledgement: {
          snapshotRunIds: ['r1', 'r2'],
          targetRunIds: ['r1'],
        },
      },
    });

    expect(scheduler.runNow).toHaveBeenCalledWith('a1', {
      acknowledgement: {
        snapshotRunIds: ['r1', 'r2'],
        targetRunIds: ['r1'],
      },
    });
  });

  it('rejects a malformed run-now body', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));

    await expect(
      routes.get('post /automations/:id/run')!.handler({
        params: { id: 'a1' },
        query: {},
        body: {
          uncertaintyAcknowledgement: {
            snapshotRunIds: 'r1',
            targetRunIds: [],
          },
        },
      }),
    ).rejects.toThrow(/uncertaintyAcknowledgement\.snapshotRunIds/);
  });

  it('falls back to the automation service when the scheduler has no run-now hook', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(
      createAutomationRoutes({
        automations,
        subagents,
        scheduler: { abort: vi.fn(), kick: vi.fn(async () => {}) },
      }),
    );

    const res = await routes.get('post /automations/:id/run')!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });

    expect(automations.runNow).toHaveBeenCalledWith('a1');
    expect(res).toEqual({ status: 200, body: 'ran' });
  });

  it('rejects acknowledged run-now when a queued scheduled run already owns the monitor', async () => {
    let releaseA!: () => void;
    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const harness = realRouteHarness({
      checks: {
        run: async (_spec, ctx) => {
          if (ctx.automationId === 'id1') {
            return new Promise<CheckResult>((resolve) => {
              releaseA = () =>
                resolve({
                  code: 0,
                  status: 'queued',
                  conclusion: null,
                  text: 'queued',
                  occurrenceKey: null,
                });
            });
          }
          return {
            code: 0,
            status: 'completed',
            conclusion: 'success',
            text: 'ok',
            occurrenceKey: 'run-b',
          };
        },
      },
      actions: { run: actionsRun },
    });
    try {
      const first = harness.due('A');
      const second = harness.due('B');
      harness.repo.appendRun(harness.uncertain(second));

      const ticking = harness.scheduler.tick();
      await Promise.resolve();

      expect(harness.repo.findOpenRun(second.id)).toMatchObject({
        source: 'scheduled',
        phase: 'queued',
        acknowledgedRunIds: null,
        acknowledgedSnapshotRunIds: null,
      });

      await expect(
        harness.routes.get('post /automations/:id/run')!.handler({
          params: { id: second.id },
          query: {},
          body: {
            uncertaintyAcknowledgement: {
              snapshotRunIds: [`uncertain-${second.id}`],
              targetRunIds: [`uncertain-${second.id}`],
            },
          },
        }),
      ).rejects.toThrow(
        new ConflictError(
          'A queued scheduled run already owns this monitor, so the retry acknowledgement could not be applied. Wait for it to finish or cancel it, then refresh and retry.',
        ),
      );

      releaseA();
      await ticking;
      await expect(harness.scheduler.waitForIdle(100)).resolves.toBe(true);

      expect(actionsRun).not.toHaveBeenCalled();
      expect(harness.repo.listRuns(second.id)).toContainEqual(
        expect.objectContaining({
          source: 'scheduled',
          detail:
            'Automatic action replay is blocked for occurrence "run-b" because a previous attempt may already have run. Use Run now only if you intend to retry it.',
        }),
      );
      expect(first.id).toBe('id1');
    } finally {
      harness.db.close();
    }
  });

  it('rejects acknowledged run-now when a running scheduled check already owns the monitor', async () => {
    let releaseB!: () => void;
    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const harness = realRouteHarness({
      checks: {
        run: async () =>
          new Promise<CheckResult>((resolve) => {
            releaseB = () =>
              resolve({
                code: 0,
                status: 'completed',
                conclusion: 'success',
                text: 'ok',
                occurrenceKey: 'run-b',
              });
          }),
      },
      actions: { run: actionsRun },
    });
    try {
      const automation = harness.due('B');
      harness.repo.appendRun(harness.uncertain(automation));

      const ticking = harness.scheduler.tick();
      await Promise.resolve();

      expect(harness.repo.findOpenRun(automation.id)).toMatchObject({
        source: 'scheduled',
        phase: 'checking',
        acknowledgedRunIds: null,
        acknowledgedSnapshotRunIds: null,
      });

      await expect(
        harness.routes.get('post /automations/:id/run')!.handler({
          params: { id: automation.id },
          query: {},
          body: {
            uncertaintyAcknowledgement: {
              snapshotRunIds: [`uncertain-${automation.id}`],
              targetRunIds: [`uncertain-${automation.id}`],
            },
          },
        }),
      ).rejects.toThrow(
        new ConflictError(
          'A running scheduled run already owns this monitor, so the retry acknowledgement could not be applied. Wait for it to finish or cancel it, then refresh and retry.',
        ),
      );

      releaseB();
      await ticking;
      await expect(harness.scheduler.waitForIdle(100)).resolves.toBe(true);

      expect(actionsRun).not.toHaveBeenCalled();
      expect(harness.repo.listRuns(automation.id)).toContainEqual(
        expect.objectContaining({
          source: 'scheduled',
          detail:
            'Automatic action replay is blocked for occurrence "run-b" because a previous attempt may already have run. Use Run now only if you intend to retry it.',
        }),
      );
    } finally {
      harness.db.close();
    }
  });

  it('rejects a malformed interval body', () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    expect(() =>
      routes.get('post /automations/:id/interval')!.handler({
        params: { id: 'a1' },
        query: {},
        body: { intervalMs: -1 },
      }),
    ).toThrow(/positive/);
  });

  it('updates automation progress', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('post /automations/:id/progress')!.handler({
      params: { id: 'a1' },
      query: {},
      body: { progress: 'half done' },
    });
    expect(res).toEqual({ status: 200, body: 'automation-progress' });
    expect(automations.updateProgress).toHaveBeenCalledWith('a1', 'half done');
  });

  it('sets automation planned steps', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const steps = [
      { id: 's1', label: 'Start', status: 'active', detail: null },
    ];
    const res = await routes.get('post /automations/:id/planned-steps')!.handler({
      params: { id: 'a1' },
      query: {},
      body: { steps },
    });
    expect(res).toEqual({ status: 200, body: 'planned' });
    expect(automations.setPlannedSteps).toHaveBeenCalledWith('a1', steps);
  });

  it('registers a subagent under an automation', async () => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get('post /automations/:id/subagents')!.handler({
      params: { id: 'a1' },
      query: {},
      body: { task: 'Investigate', origin: { sessionId: 's1' } },
    });
    expect(res).toEqual({ status: 201, body: 'registered' });
    expect(subagents.register).toHaveBeenCalledWith({
      task: 'Investigate',
      origin: { sessionId: 's1', featureId: null },
      automationId: 'a1',
    });
  });

  it.each([
    ['post /subagents/:id/progress', 'updateProgress', { progress: 'working' }],
    ['post /subagents/:id/complete', 'complete', { result: 'done' }],
    ['post /subagents/:id/fail', 'fail', { error: 'boom' }],
  ])('drives subagent route %s', async (signature, method, body) => {
    const { automations, subagents } = services();
    const routes = routeMap(createAutomationRoutes({ automations, subagents }));
    const res = await routes.get(signature)!.handler({
      params: { id: 'g1' },
      query: {},
      body,
    });
    expect(res.status).toBe(200);
    expect(subagents[method]).toHaveBeenCalledWith(
      'g1',
      Object.values(body)[0],
    );
  });

  it('deletes an automation and returns its id', async () => {
    const { automations, subagents } = services();
    const order: string[] = [];
    vi.mocked(automations.remove).mockImplementation(async () => {
      order.push('remove');
    });
    const scheduler = {
      abort: vi.fn(() => {
        order.push('abort');
      }),
      kick: vi.fn(async () => {}),
    };
    const routes = routeMap(
      createAutomationRoutes({ automations, subagents, scheduler }),
    );
    const res = await routes.get('delete /automations/:id')!.handler({
      params: { id: 'a1' },
      query: {},
      body: undefined,
    });
    expect(res).toEqual({ status: 200, body: { id: 'a1' } });
    expect(automations.remove).toHaveBeenCalledWith('a1');
    expect(scheduler.abort).toHaveBeenCalledWith('a1');
    expect(order).toEqual(['abort', 'remove']);
  });
});
