import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import { createAutomationService } from './automation-service.js';
import { createSubagentService } from './subagent-service.js';
import type { SubagentEventMap } from './subagent-service.js';
import { createActionRunner } from './action-runner.js';
import type {
  AutomationEventMap,
  CreateAutomationInput,
} from './automation-service.js';
import {
  createAutomationScheduler,
  describeWaitingProgress,
} from './automation-scheduler.js';
import { pendingUncertainRuns } from './automation-uncertainty.js';
import type {
  ActionResult,
  Automation,
  AutomationRepo,
  AutomationRun,
  CheckResult,
  CheckRunner,
  ActionRunner,
  Subagent,
  SubagentRepo,
} from './automation-contract.js';

function fakeRepo(): AutomationRepo & { runs: AutomationRun[] } {
  const store = new Map<string, Automation>();
  const runs: AutomationRun[] = [];
  return {
    runs,
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
      for (let index = runs.length - 1; index >= 0; index -= 1) {
        if (runs[index]?.automationId === id) {
          runs.splice(index, 1);
        }
      }
    },
    appendRun(r) {
      runs.push(r);
    },
    getRun(id) {
      return runs.find((r) => r.id === id) ?? null;
    },
    saveRun(run) {
      const index = runs.findIndex((r) => r.id === run.id);
      if (index >= 0) {
        runs[index] = run;
      } else {
        runs.push(run);
      }
    },
    findOpenRun(automationId) {
      return (
        runs.find(
          (run) =>
            run.automationId === automationId &&
            (run.phase === 'queued' ||
              run.phase === 'checking' ||
              run.phase === 'acting'),
        ) ?? null
      );
    },
    listOpenRuns() {
      return runs.filter(
        (run) =>
          run.phase === 'queued' ||
          run.phase === 'checking' ||
          run.phase === 'acting',
      );
    },
    listRuns(id) {
      return runs.filter((r) => r.automationId === id);
    },
    listPendingUncertainRuns(id) {
      return pendingUncertainRuns(runs.filter((r) => r.automationId === id));
    },
    transact(work) {
      return work();
    },
  };
}

function counterIds() {
  let n = 0;
  return { next: () => `id${++n}` };
}

function fakeSubagentRepo(): SubagentRepo {
  const store = new Map<string, Subagent>();
  return {
    create(s) {
      store.set(s.id, s);
    },
    get(id) {
      return store.get(id) ?? null;
    },
    list() {
      return [...store.values()];
    },
    save(s) {
      store.set(s.id, s);
    },
    listByAutomation(id) {
      return [...store.values()].filter((s) => s.automationId === id);
    },
    deleteByAutomation(automationId) {
      for (const [id, subagent] of store.entries()) {
        if (subagent.automationId === automationId) {
          store.delete(id);
        }
      }
    },
    deleteByOriginFeature(featureId) {
      for (const [id, subagent] of store.entries()) {
        if (subagent.origin.featureId === featureId) {
          store.delete(id);
        }
      }
    },
    deleteByOriginSession(sessionId) {
      for (const [id, subagent] of store.entries()) {
        if (subagent.origin.sessionId === sessionId) {
          store.delete(id);
        }
      }
    },
  };
}

const okResult: CheckResult = {
  code: 0,
  status: 'completed',
  conclusion: 'success',
  text: 'ok',
  occurrenceKey: null,
};

function checkReturning(result: CheckResult | (() => CheckResult)): CheckRunner {
  return {
    run: async () => (typeof result === 'function' ? result() : result),
  };
}

function checkThrowing(message: string): CheckRunner {
  return {
    run: async () => {
      throw new Error(message);
    },
  };
}

const action: ActionResult = {
  detail: 'action ran',
  sessionId: 'm1',
  subagentId: null,
  report: null,
};

function actionReturning(result: ActionResult): ActionRunner {
  return { run: async () => result };
}

function actionThrowing(message: string): ActionRunner {
  return {
    run: async () => {
      throw new Error(message);
    },
  };
}

describe('automation-scheduler', () => {
  let repo: ReturnType<typeof fakeRepo>;
  let time: number;
  let service: ReturnType<typeof createAutomationService>;
  let bus: ReturnType<typeof createEventBus<AutomationEventMap>>;

  beforeEach(() => {
    repo = fakeRepo();
    time = Date.UTC(2026, 0, 1);
    bus = createEventBus<AutomationEventMap>();
    service = createAutomationService({
      repo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
  });

  function scheduler(
    checks: CheckRunner,
    actions: ActionRunner,
    config: Partial<{ minIntervalMs: number; maxConcurrentChecks: number }> = {},
  ) {
    return createAutomationScheduler({
      repo,
      checks,
      actions,
      clock: createClock(() => time),
      ids: counterIds(),
      bus,
      config: {
        minIntervalMs: config.minIntervalMs ?? 10_000,
        maxConcurrentChecks: config.maxConcurrentChecks ?? 2,
      },
    });
  }

  function dueAutomation(overrides: Partial<CreateAutomationInput> = {}): Automation {
    const input: CreateAutomationInput = {
      name: 'Monitor',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
      ...overrides,
    };
    const created = service.create(input);
    return service.runNow(created.id);
  }

  it('does nothing when no automations are due', async () => {
    service.create({
      name: 'x',
      mode: 'long',
      check: { type: 'shell', command: 'e' },
      condition: { type: 'always' },
      action: { type: 'report', prompt: 'p' },
    });
    // Not due: nextRunAt is in the future.
    await scheduler(checkReturning(okResult), actionReturning(action)).tick();
    expect(repo.runs).toHaveLength(0);
  });

  it('falls back to check text when status is null on a non-triggering run', async () => {
    const a = dueAutomation();
    await scheduler(
      checkReturning({ ...okResult, status: null, text: 'pending output' }),
      actionReturning(action),
    ).tick();
    const runs = repo.listRuns(a.id);
    expect(runs[0]?.detail).toBe('Checked: pending output');
    expect(service.get(a.id).progress).toBe(
      'Waiting for status "completed" · last result: pending output',
    );
  });

  it('records a non-triggering check and reschedules a long monitor', async () => {
    const a = dueAutomation();
    await scheduler(
      checkReturning({ ...okResult, status: 'in_progress' }),
      actionReturning(action),
    ).tick();
    const runs = repo.listRuns(a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggered).toBe(false);
    expect(runs[0]?.status).toBe('ok');
    const after = service.get(a.id);
    expect(after.status).toBe('active');
    expect(after.nextRunAt).toBe(new Date(time + a.intervalMs).toISOString());
    expect(after.progress).toBe(
      'Waiting for status "completed" · last result: in_progress',
    );
  });

  it('records a non-triggering check without reviving a paused automation snapshot', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(localService.create({
      name: 'Monitor',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    }).id);
    const originalGet = localRepo.get.bind(localRepo);
    let postCheckGets = 0;
    let checkCompleted = false;
    localRepo.get = (id) => {
      const current = originalGet(id);
      if (id !== automation.id || current === null || !checkCompleted) {
        return current;
      }
      postCheckGets += 1;
      if (postCheckGets >= 3) {
        return { ...current, status: 'paused', nextRunAt: null };
      }
      return current;
    };
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: {
        run: async () => {
          checkCompleted = true;
          return { ...okResult, status: 'in_progress' };
        },
      },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(localRepo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'ok',
        detail: 'Checked: in_progress',
      }),
    );
    expect(localService.get(automation.id).status).toBe('paused');
  });

  it('records non-triggering timestamps from the queued start when dispatch metadata is missing', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalSaveRun = localRepo.saveRun.bind(localRepo);
    localRepo.saveRun = (run) => {
      if (run.phase === 'checking') {
        originalSaveRun({ ...run, dispatchedAt: null });
        return;
      }
      originalSaveRun(run);
    };
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: {
        run: async () => ({ ...okResult, status: 'in_progress' }),
      },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(localService.get(automation.id)).toMatchObject({
      lastCheckedAt: automation.nextRunAt,
      progress: 'Waiting for status "completed" · last result: in_progress',
    });
  });

  it.each([
    [
      { type: 'exit-code' as const, equals: 0 },
      { ...okResult, code: 1, status: '1', text: 'still running' },
      'Waiting for exit code 0 · last result: exit 1',
    ],
    [
      { type: 'conclusion-equals' as const, value: 'success' },
      { ...okResult, conclusion: 'failure' },
      'Waiting for conclusion "success" · last result: completed',
    ],
    [
      { type: 'text-contains' as const, value: 'done' },
      { ...okResult, text: 'not yet' },
      'Waiting for text containing "done" · last result: completed',
    ],
    [
      { type: 'ai-verdict' as const },
      { ...okResult, code: 0, status: 'no' },
      'Waiting for an affirmative AI verdict · last result: no',
    ],
  ])('records meaningful waiting progress for %s', async (condition, result, progress) => {
    const a = dueAutomation({ condition });
    await scheduler(checkReturning(result), actionReturning(action)).tick();
    expect(service.get(a.id).progress).toBe(progress);
  });

  it('describes the always condition for defensive callers', () => {
    const a = dueAutomation({ condition: { type: 'always' } });
    expect(describeWaitingProgress(a, { ...okResult, status: 'pending' })).toBe(
      'Waiting for the condition · last result: pending',
    );
  });

  it('fires the action for a matching long monitor and reschedules', async () => {
    const a = dueAutomation();
    await scheduler(
      checkReturning({ ...okResult, occurrenceKey: 'run-1' }),
      actionReturning(action),
    ).tick();
    const after = service.get(a.id);
    expect(after.runCount).toBe(1);
    expect(after.lastOccurrenceKey).toBe('run-1');
    expect(after.status).toBe('active');
    expect(after.progress).toBe('action ran');
    const runs = repo.listRuns(a.id);
    expect(runs[0]?.triggered).toBe(true);
    expect(runs[0]?.sessionId).toBe('m1');
  });

  it('records successful action timestamps from the queued start when dispatch metadata is missing', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalSaveRun = localRepo.saveRun.bind(localRepo);
    localRepo.saveRun = (run) => {
      if (run.phase === 'acting') {
        originalSaveRun({ ...run, dispatchedAt: null });
        return;
      }
      originalSaveRun(run);
    };
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: { run: async () => okResult },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(localService.get(automation.id)).toMatchObject({
      lastCheckedAt: automation.nextRunAt,
      progress: 'action ran',
    });
  });

  it('is edge-triggered: the same occurrence does not fire twice', async () => {
    const a = dueAutomation();
    const sched = scheduler(
      checkReturning({ ...okResult, occurrenceKey: 'run-1' }),
      actionReturning(action),
    );
    await sched.tick();
    service.runNow(a.id);
    await sched.tick();
    expect(service.get(a.id).runCount).toBe(1);
    // Second tick recorded a non-triggering run.
    expect(repo.listRuns(a.id).filter((r) => r.triggered)).toHaveLength(1);
  });

  it('completes a short monitor after the first trigger', async () => {
    const a = dueAutomation({ mode: 'short' });
    await scheduler(checkReturning(okResult), actionReturning(action)).tick();
    const after = service.get(a.id);
    expect(after.status).toBe('completed');
    expect(after.nextRunAt).toBeNull();
    expect(after.runCount).toBe(1);
  });

  it('completes a long monitor when maxRuns is reached', async () => {
    const a = dueAutomation({ maxRuns: 1 });
    await scheduler(
      checkReturning({ ...okResult, occurrenceKey: 'run-1' }),
      actionReturning(action),
    ).tick();
    expect(service.get(a.id).status).toBe('completed');
  });

  it('records a failed run and keeps polling when the check throws', async () => {
    const a = dueAutomation();
    await scheduler(checkThrowing('net down'), actionReturning(action)).tick();
    const runs = repo.listRuns(a.id);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.detail).toContain('net down');
    const after = service.get(a.id);
    expect(after.status).toBe('active');
    expect(after.progress).toContain('Check failed');
  });

  it('records a check failure without overwriting a pause that happened mid-flight', async () => {
    const a = dueAutomation();
    const checks: CheckRunner = {
      run: async () => {
        service.pause(a.id);
        throw new Error('net down');
      },
    };
    await scheduler(checks, actionReturning(action)).tick();
    expect(service.get(a.id).status).toBe('paused');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'failed',
        detail: 'Check failed: net down',
      }),
    );
  });

  it('records failed check timestamps from the queued start when dispatch metadata is missing', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalSaveRun = localRepo.saveRun.bind(localRepo);
    localRepo.saveRun = (run) => {
      if (run.phase === 'checking') {
        originalSaveRun({ ...run, dispatchedAt: null });
        return;
      }
      originalSaveRun(run);
    };
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: {
        run: async () => {
          throw new Error('net down');
        },
      },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(localService.get(automation.id)).toMatchObject({
      lastCheckedAt: automation.nextRunAt,
      progress: 'Check failed: net down',
    });
  });

  it('marks the automation failed when the action throws', async () => {
    const a = dueAutomation();
    await scheduler(checkReturning(okResult), actionThrowing('boom')).tick();
    const after = service.get(a.id);
    expect(after.status).toBe('failed');
    expect(after.nextRunAt).toBeNull();
    expect(after.failure).toBe('boom');
    const runs = repo.listRuns(a.id);
    expect(runs[0]?.triggered).toBe(true);
    expect(runs[0]?.status).toBe('failed');
  });

  it('records failed action timestamps from the queued start when dispatch metadata is missing', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalSaveRun = localRepo.saveRun.bind(localRepo);
    localRepo.saveRun = (run) => {
      if (run.phase === 'acting') {
        originalSaveRun({ ...run, dispatchedAt: null });
        return;
      }
      originalSaveRun(run);
    };
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: { run: async () => okResult },
      actions: actionThrowing('boom'),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(localService.get(automation.id)).toMatchObject({
      status: 'failed',
      lastCheckedAt: automation.nextRunAt,
      failure: 'boom',
    });
  });

  it('drops an invalid retained completion from a non-subagent action', async () => {
    const a = dueAutomation();
    const invalidAction: ActionResult = {
      ...action,
      completion: Promise.resolve(),
    };
    const sched = scheduler(checkReturning(okResult), actionReturning(invalidAction));
    await sched.tick();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'failed',
        detail: expect.stringContaining('only supported for subagent actions'),
      }),
    );
    expect(service.get(a.id).status).toBe('failed');
  });

  it('uses a generic message for a non-Error check rejection', async () => {
    const a = dueAutomation();
    const checks: CheckRunner = {
      run: async () => {
        throw 'weird';
      },
    };
    await scheduler(checks, actionReturning(action)).tick();
    expect(repo.listRuns(a.id)[0]?.detail).toContain('Automation step failed');
  });

  it('parks the monitor in needs-auth when the check throws an auth error', async () => {
    const a = dueAutomation();
    await scheduler(
      checkThrowing('Azure DevOps requires authentication'),
      actionReturning(action),
    ).tick();
    const after = service.get(a.id);
    expect(after.status).toBe('needs-auth');
    expect(after.nextRunAt).toBeNull();
    expect(after.failure).toContain('Sign-in required');
    expect(after.progress).toBe('Sign-in required');
    const runs = repo.listRuns(a.id);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.triggered).toBe(false);
    expect(runs[0]?.detail).toContain('Sign-in required');
  });

  it('records needs-auth timestamps from the queued start when dispatch metadata is missing', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalSaveRun = localRepo.saveRun.bind(localRepo);
    localRepo.saveRun = (run) => {
      if (run.phase === 'checking') {
        originalSaveRun({ ...run, dispatchedAt: null });
        return;
      }
      originalSaveRun(run);
    };
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: {
        run: async () => {
          throw new Error('Azure DevOps requires authentication');
        },
      },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(localService.get(automation.id)).toMatchObject({
      status: 'needs-auth',
      lastCheckedAt: automation.nextRunAt,
    });
  });

  it('records sign-in required without reviving a cancelled monitor', async () => {
    const a = dueAutomation();
    const checks: CheckRunner = {
      run: async () => {
        service.cancel(a.id);
        throw new Error('Azure DevOps requires authentication');
      },
    };
    await scheduler(checks, actionReturning(action)).tick();
    expect(service.get(a.id).status).toBe('cancelled');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'failed',
        detail: expect.stringContaining('Sign-in required:'),
      }),
    );
  });

  it('parks the monitor in needs-auth when the check result is a 401', async () => {
    const a = dueAutomation();
    const unauthorized: CheckResult = {
      code: 401,
      status: '401',
      conclusion: null,
      text: 'Unauthorized',
      occurrenceKey: null,
    };
    await scheduler(checkReturning(unauthorized), actionReturning(action)).tick();
    const after = service.get(a.id);
    expect(after.status).toBe('needs-auth');
    expect(after.nextRunAt).toBeNull();
    expect(repo.listRuns(a.id)[0]?.detail).toContain('Sign-in required');
  });

  it('resume reschedules active automations with no next run', () => {
    const a = dueAutomation();
    service.pause(a.id); // clears nextRunAt
    // Force an active-but-unscheduled state directly.
    repo.save({ ...service.get(a.id), status: 'active', nextRunAt: null });
    scheduler(checkReturning(okResult), actionReturning(action)).resume();
    expect(service.get(a.id).nextRunAt).toBe(new Date(time).toISOString());
  });

  it('resume ignores paused automations', () => {
    const a = dueAutomation();
    service.pause(a.id);
    scheduler(checkReturning(okResult), actionReturning(action)).resume();
    expect(service.get(a.id).nextRunAt).toBeNull();
  });

  it('processes many due monitors within the concurrency limit', async () => {
    for (let i = 0; i < 5; i++) {
      dueAutomation();
    }
    let active = 0;
    let peak = 0;
    const checks: CheckRunner = {
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return okResult;
      },
    };
    await scheduler(checks, actionReturning(action)).tick();
    expect(peak).toBeLessThanOrEqual(2);
    expect(repo.runs.length).toBeGreaterThanOrEqual(5);
  });

  it('does not resurrect a monitor cancelled while its check is in flight', async () => {
    const a = dueAutomation();
    // The check cancels the monitor mid-flight, then resolves without matching.
    const checks: CheckRunner = {
      run: async () => {
        service.cancel(a.id);
        return { ...okResult, status: 'in_progress' };
      },
    };
    await scheduler(checks, actionReturning(action)).tick();
    const after = service.get(a.id);
    expect(after.status).toBe('cancelled');
    expect(after.nextRunAt).toBeNull();
    expect(after.progress ?? '').not.toContain('Waiting');
  });

  it('does not resurrect a monitor paused while a firing action is in flight', async () => {
    const a = dueAutomation();
    const actions: ActionRunner = {
      run: async () => {
        service.pause(a.id);
        return action;
      },
    };
    await scheduler(checkReturning(okResult), actions).tick();
    const after = service.get(a.id);
    expect(after.status).toBe('paused');
    // The action still recorded a run, but the status write was suppressed.
    expect(repo.listRuns(a.id).some((r) => r.triggered)).toBe(true);
  });

  it('records an action failure without overwriting a pause that happened mid-flight', async () => {
    const a = dueAutomation();
    const actions: ActionRunner = {
      run: async () => {
        service.pause(a.id);
        throw new Error('boom');
      },
    };
    await scheduler(checkReturning(okResult), actions).tick();
    const after = service.get(a.id);
    expect(after.status).toBe('paused');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        triggered: true,
        status: 'failed',
        detail: 'Action failed: boom',
      }),
    );
  });

  it('does not record or persist a result after the monitor is deleted mid-action', async () => {
    const a = dueAutomation();
    const actions: ActionRunner = {
      run: async () => {
        await service.remove(a.id);
        return action;
      },
    };
    await expect(
      scheduler(checkReturning(okResult), actions).tick(),
    ).resolves.toBeUndefined();
    expect(service.list().some((x) => x.id === a.id)).toBe(false);
    expect(repo.listRuns(a.id)).toHaveLength(0);
  });

  it('does not throw or save when a monitor is deleted mid-check', async () => {
    const a = dueAutomation();
    const checks: CheckRunner = {
      run: async () => {
        await service.remove(a.id);
        return { ...okResult, status: 'in_progress' };
      },
    };
    await expect(
      scheduler(checks, actionReturning(action)).tick(),
    ).resolves.toBeUndefined();
    expect(service.list().some((x) => x.id === a.id)).toBe(false);
  });

  it('aborts an in-flight check when requested', async () => {
    const a = dueAutomation();
    let signal: AbortSignal | undefined;
    let resolveCheck!: () => void;
    const checks: CheckRunner = {
      run: (_spec, ctx) =>
        new Promise<CheckResult>((resolve) => {
          signal = ctx.signal;
          resolveCheck = () =>
            resolve({ ...okResult, status: 'in_progress' });
        }),
    };
    const sched = scheduler(checks, actionReturning(action));
    const running = sched.tick();
    await Promise.resolve();
    service.cancel(a.id);
    sched.abort(a.id);
    expect(signal?.aborted).toBe(true);
    resolveCheck();
    await running;
    expect(service.get(a.id).status).toBe('cancelled');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({ phase: 'cancelled', status: 'skipped' }),
    );
  });

  it('cancels an active manual run without rescheduling it as a scheduled retry', async () => {
    let signal: AbortSignal | undefined;
    let resolveCheck!: () => void;
    const sched = scheduler(
      {
        run: (_spec, ctx) =>
          new Promise<CheckResult>((resolve) => {
            signal = ctx.signal;
            resolveCheck = () => resolve({ ...okResult, status: 'in_progress' });
          }),
      },
      actionReturning(action),
    );
    const a = service.create({
      name: 'Manual',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });

    void sched.runNow(a.id);
    await Promise.resolve();
    sched.abort(a.id);
    expect(signal?.aborted).toBe(true);
    resolveCheck();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);

    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        source: 'manual',
        phase: 'cancelled',
        status: 'skipped',
      }),
    );
    expect(service.get(a.id).nextRunAt).toBe(a.nextRunAt);
  });

  it('does not mark a cancelled monitor failed when an aborted check rejects', async () => {
    const a = dueAutomation({ check: { type: 'ai', prompt: 'ready?' } });
    const checks: CheckRunner = {
      run: async (_spec, ctx) =>
        new Promise<CheckResult>((_resolve, reject) => {
          ctx.signal?.addEventListener(
            'abort',
            () => reject(new Error('Meta request cancelled')),
            { once: true },
          );
        }),
    };
    const sched = scheduler(checks, actionReturning(action));
    const running = sched.tick();
    await Promise.resolve();
    service.cancel(a.id);
    sched.abort(a.id);
    await running;
    expect(service.get(a.id).status).toBe('cancelled');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({ phase: 'cancelled', status: 'skipped' }),
    );
  });

  it('does not mark a cancelled monitor failed when an aborted action rejects', async () => {
    const a = dueAutomation({ check: { type: 'ai', prompt: 'ready?' } });
    const actions: ActionRunner = {
      run: async (_spec, ctx) =>
        new Promise<ActionResult>((_resolve, reject) => {
          ctx.signal?.addEventListener(
            'abort',
            () => reject(new Error('Meta request cancelled')),
            { once: true },
          );
        }),
    };
    const sched = scheduler(checkReturning(okResult), actions);
    const running = sched.tick();
    await Promise.resolve();
    service.cancel(a.id);
    sched.abort(a.id);
    await running;
    expect(service.get(a.id).status).toBe('cancelled');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        phase: 'uncertain',
        status: 'failed',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
  });

  it('fails a short monitor when an aborted action may already have run', async () => {
    const a = dueAutomation({
      mode: 'short',
      check: { type: 'ai', prompt: 'ready?' },
    });
    const actions: ActionRunner = {
      run: async (_spec, ctx) =>
        new Promise<ActionResult>((_resolve, reject) => {
          ctx.signal?.addEventListener(
            'abort',
            () => reject(new Error('Meta request cancelled')),
            { once: true },
          );
        }),
    };
    const sched = scheduler(checkReturning(okResult), actions);

    const running = sched.tick();
    await Promise.resolve();
    sched.abort(a.id);
    await running;

    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        phase: 'uncertain',
        status: 'failed',
      }),
    );
    expect(service.get(a.id)).toMatchObject({
      status: 'failed',
      nextRunAt: null,
      failure:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });
  });

  it('records a retained action success once completion settles', async () => {
    const a = dueAutomation();
    let resolveCompletion!: () => void;
    const retainedAction: ActionResult = {
      ...action,
      subagentId: 'g1',
      completion: new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      }),
    };
    const sched = scheduler(checkReturning(okResult), actionReturning(retainedAction));
    await sched.tick();
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({ phase: 'acting', detail: 'Running action' }),
    );
    resolveCompletion();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({ triggered: true, status: 'ok', detail: 'action ran' }),
    );
    expect(service.get(a.id).progress).toBe('action ran');
  });

  it('suppresses a retained action success if the monitor is deleted before completion settles', async () => {
    const a = dueAutomation();
    let resolveCompletion!: () => void;
    const retainedAction: ActionResult = {
      ...action,
      subagentId: 'g1',
      completion: new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      }),
    };
    const sched = scheduler(checkReturning(okResult), actionReturning(retainedAction));
    await sched.tick();
    await service.remove(a.id);
    resolveCompletion();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(service.list().some((item) => item.id === a.id)).toBe(false);
    expect(repo.listRuns(a.id)).toHaveLength(0);
  });

  it('records a retained action failure once completion settles', async () => {
    const a = dueAutomation();
    let rejectCompletion!: (error: Error) => void;
    const retainedAction: ActionResult = {
      ...action,
      subagentId: 'g1',
      completion: new Promise<void>((_resolve, reject) => {
        rejectCompletion = reject;
      }),
    };
    const sched = scheduler(checkReturning(okResult), actionReturning(retainedAction));
    await sched.tick();
    rejectCompletion(new Error('later boom'));
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(service.get(a.id).status).toBe('failed');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        triggered: true,
        status: 'failed',
        detail: 'Action failed: later boom',
      }),
    );
  });

  it('does not recreate an already-deleted monitor when its retained action later fails', async () => {
    const a = dueAutomation();
    let rejectCompletion!: (error: Error) => void;
    const sched = scheduler(checkReturning(okResult), actionReturning({
      ...action,
      subagentId: 'g1',
      completion: new Promise<void>((_resolve, reject) => { rejectCompletion = reject; }),
    }));
    await sched.tick();
    await service.remove(a.id);
    rejectCompletion(new Error('late failure'));
    expect(await sched.waitForIdle(100)).toBe(true);
    expect(repo.get(a.id)).toBeNull();
    expect(repo.listRuns(a.id)).toEqual([]);
  });

  it('retains subagent cancellation ownership after tick returns and suppresses late success', async () => {
    const a = dueAutomation({
      action: { type: 'subagent', task: 'Investigate', prompt: 'go' },
    });
    let signal: AbortSignal | undefined;
    let rejectAi!: (error: Error) => void;
    const subagents = createSubagentService({
      repo: fakeSubagentRepo(),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: createEventBus<SubagentEventMap>(),
      ai: {
        run: async (input) =>
          new Promise((_resolve, reject) => {
            signal = input.signal;
            rejectAi = reject;
          }),
      },
      timeoutMs: 1_000,
    });
    const actions = createActionRunner({
      ai: { run: async () => ({ text: '', sessionId: 'm1' }) },
      shell: { exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
      subagents,
      timeoutMs: 1_000,
    });
    const sched = scheduler(checkReturning(okResult), actions);

    await sched.tick();
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({ phase: 'acting', detail: expect.stringContaining('Subagent started') }),
    );
    service.cancel(a.id);
    sched.abort(a.id);
    expect(signal?.aborted).toBe(true);
    rejectAi(new Error('Meta request cancelled'));
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(service.get(a.id).status).toBe('cancelled');
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({
        phase: 'uncertain',
        status: 'failed',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    expect(subagents.listByAutomation(a.id)[0]?.status).not.toBe('done');
  });

  it('kick starts one due automation immediately', async () => {
    const a = dueAutomation();
    const checks = checkReturning({ ...okResult, occurrenceKey: 'run-1' });
    const sched = scheduler(checks, actionReturning(action));
    sched.kick(a.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.get(a.id).runCount).toBe(1);
  });

  it('abortAll aborts every in-flight check', async () => {
    const a = dueAutomation();
    let signal: AbortSignal | undefined;
    let resolveCheck!: () => void;
    const checks: CheckRunner = {
      run: (_spec, ctx) =>
        new Promise<CheckResult>((resolve) => {
          signal = ctx.signal;
          resolveCheck = () => resolve(okResult);
        }),
    };
    const sched = scheduler(checks, actionReturning(action));
    const running = sched.tick();
    await Promise.resolve();
    sched.abortAll();
    expect(signal?.aborted).toBe(true);
    resolveCheck();
    await running;
    expect(repo.listRuns(a.id)).toContainEqual(
      expect.objectContaining({ phase: 'cancelled', status: 'skipped' }),
    );
  });

  it('shutdown latches admissions so queued work never starts after the first run is aborted', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    const started: string[] = [];
    let resolveFirst!: () => void;
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        started.push(ctx.automationId);
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        return { ...okResult, status: 'in_progress' };
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });
    const running = sched.tick();
    await Promise.resolve();
    expect(started).toEqual([first.id]);
    sched.kick(second.id);
    await Promise.resolve();
    expect(started).toEqual([first.id]);

    const waiting = sched.waitForIdle(100);
    sched.shutdown();
    resolveFirst();
    await running;
    await expect(waiting).resolves.toBe(true);
    expect(started).toEqual([first.id]);
    expect(repo.listRuns(first.id)).toContainEqual(
      expect.objectContaining({ phase: 'cancelled', status: 'skipped' }),
    );
    expect(repo.listRuns(second.id)).toContainEqual(
      expect.objectContaining({ phase: 'queued', status: 'skipped' }),
    );
  });

  it('quiesces a monitor without admitting retries or waiting for an unrelated monitor', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    const pending = new Map<string, () => void>();
    const sched = scheduler({
      run: (_spec, context) => new Promise<CheckResult>((resolve) => {
        pending.set(context.automationId, () => resolve({ ...okResult, status: 'in_progress' }));
      }),
    }, actionReturning(action));
    const ticking = sched.tick();
    await Promise.resolve();
    expect([...pending.keys()]).toEqual([first.id, second.id]);
    expect(await sched.quiesce(first.id, 1)).toBe(false);
    await expect(sched.runNow(first.id)).rejects.toMatchObject({ kind: 'conflict' });
    await sched.kick(first.id);
    await sched.tick();
    expect(repo.listRuns(first.id)).toHaveLength(1);
    const firstIdle = sched.waitForIdle(100, first.id);
    pending.get(first.id)!();
    expect(await firstIdle).toBe(true);
    expect(await sched.waitForIdle(1)).toBe(false);
    pending.get(second.id)!();
    await ticking;
    expect(await sched.waitForIdle(100)).toBe(true);
  });

  it('drops a queued monitor before deletion without dispatching it', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    let finish!: () => void;
    const seen: string[] = [];
    const sched = scheduler({
      run: (_spec, context) => {
        seen.push(context.automationId);
        return new Promise<CheckResult>((resolve) => {
          finish = () => resolve({ ...okResult, status: 'in_progress' });
        });
      },
    }, actionReturning(action), { maxConcurrentChecks: 1 });
    const ticking = sched.tick();
    expect(await sched.quiesce(second.id, 100)).toBe(true);
    expect(seen).toEqual([first.id]);
    expect(repo.listRuns(second.id)[0].phase).toBe('cancelled');
    finish();
    await ticking;
    expect(seen).toEqual([first.id]);
  });

  it('abort cancels a queued occurrence before dispatch', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    let resolveFirst!: () => void;
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        return okResult;
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    const running = sched.tick();
    await Promise.resolve();
    sched.abort(second.id);
    resolveFirst();
    await running;

    expect(repo.listRuns(second.id)).toContainEqual(
      expect.objectContaining({
        phase: 'cancelled',
        detail: 'Run cancelled before dispatch',
      }),
    );
  });

  it('releases a queued admission even when the monitor was deleted before abort cleanup', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    let resolveFirst!: () => void;
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        return okResult;
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    const running = sched.tick();
    await Promise.resolve();
    await service.remove(second.id);
    sched.abort(second.id);
    resolveFirst();
    await running;

    expect(repo.listRuns(second.id)).toHaveLength(0);
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
  });

  it('treats duplicate queued aborts as idempotent', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    let resolveFirst!: () => void;
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        return okResult;
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    const running = sched.tick();
    await Promise.resolve();
    sched.abort(second.id);
    sched.abort(second.id);
    resolveFirst();
    await running;

    expect(repo.listRuns(second.id)).toContainEqual(
      expect.objectContaining({ phase: 'cancelled' }),
    );
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
  });

  it('does not double-start a queued automation when kick overlaps tick, and shutdown reaches idle', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    const started: string[] = [];
    const signals = new Map<string, AbortSignal[]>();
    let resolveFirst!: () => void;
    let secondStarted!: () => void;
    const secondRunning = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        started.push(ctx.automationId);
        const list = signals.get(ctx.automationId) ?? [];
        list.push(ctx.signal!);
        signals.set(ctx.automationId, list);
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        secondStarted();
        return new Promise<CheckResult>((_resolve, reject) => {
          ctx.signal!.addEventListener(
            'abort',
            () => reject(new Error('aborted B')),
            { once: true },
          );
        });
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    const running = sched.tick();
    await Promise.resolve();
    expect(started).toEqual([first.id]);

    sched.kick(second.id);
    await Promise.resolve();
    expect(started).toEqual([first.id]);
    expect(signals.get(second.id) ?? []).toHaveLength(0);
    resolveFirst();
    resolveFirst();
    await secondRunning;
    expect(started).toEqual([first.id, second.id]);
    expect(signals.get(second.id) ?? []).toHaveLength(1);

    const waiting = sched.waitForIdle(100);
    sched.shutdown();
    expect(signals.get(second.id)?.every((signal) => signal.aborted)).toBe(true);
    await running;
    await expect(waiting).resolves.toBe(true);
    expect(repo.listRuns(first.id)).toHaveLength(1);
    expect(repo.listRuns(second.id)).toHaveLength(1);
    expect(repo.listRuns(second.id)[0]).toMatchObject({
      phase: 'cancelled',
      status: 'skipped',
    });
  });

  it('does not re-admit a queued automation when another tick overlaps the same due item', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    const started: string[] = [];
    let resolveFirst!: () => void;
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        started.push(ctx.automationId);
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        return { ...okResult, status: 'in_progress' };
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    const running = sched.tick();
    await Promise.resolve();
    expect(started).toEqual([first.id]);

    await sched.tick();
    resolveFirst();
    await running;

    expect(started).toEqual([first.id, second.id]);
    await expect(sched.waitForIdle(1)).resolves.toBe(true);
  });

  it('kick ignores missing, future, and already running automations', async () => {
    const a = service.create({
      name: 'Future',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'always' },
      action: { type: 'report', prompt: 'go' },
    });
    let checksRun = 0;
    const checks: CheckRunner = {
      run: async () => {
        checksRun++;
        return okResult;
      },
    };
    const sched = scheduler(checks, actionReturning(action));
    sched.kick('missing');
    sched.kick(a.id);
    await Promise.resolve();
    expect(checksRun).toBe(0);
    service.runNow(a.id);
    sched.kick(a.id);
    sched.kick(a.id);
    await Promise.resolve();
    expect(checksRun).toBe(1);
  });

  it.each([
    ['paused', (id: string) => service.pause(id)],
    ['cancelled', (id: string) => service.cancel(id)],
    ['deleted', (id: string) => service.remove(id)],
  ] as const)(
    'revalidates queued work and drops %s automations before dispatch',
    async (_label, mutate) => {
      const first = dueAutomation({ name: 'A' });
      const second = dueAutomation({ name: 'B' });
      const started: string[] = [];
      let resolveFirst!: () => void;
      const checks: CheckRunner = {
        run: async (_spec, ctx) => {
          started.push(ctx.automationId);
          if (ctx.automationId === first.id) {
            return new Promise<CheckResult>((resolve) => {
              resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
            });
          }
          return { ...okResult, status: 'in_progress' };
        },
      };
      const sched = scheduler(checks, actionReturning(action), {
        maxConcurrentChecks: 1,
      });

      const running = sched.tick();
      await Promise.resolve();
      await mutate(second.id);
      resolveFirst();
      await running;

      expect(started).toEqual([first.id]);
      await expect(sched.waitForIdle(1)).resolves.toBe(true);
      if (_label === 'deleted') {
        expect(repo.listRuns(second.id)).toHaveLength(0);
        return;
      }
      expect(repo.listRuns(second.id)).toContainEqual(
        expect.objectContaining({ phase: 'cancelled', status: 'skipped' }),
      );
    },
  );

  it('marks a resumed queued run cancelled when the automation changed before restart', async () => {
    const a = dueAutomation();
    const run: AutomationRun = {
      id: 'queued-run',
      automationId: a.id,
      source: 'scheduled',
      phase: 'queued',
      scheduledForAt: a.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `scheduled:${a.id}:${a.nextRunAt}`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to check',
      sessionId: null,
    };
    repo.appendRun(run);
    service.updateInterval(a.id, 120_000);

    const sched = scheduler(checkReturning(okResult), actionReturning(action));
    sched.resume();

    expect(repo.getRun('queued-run')).toMatchObject({
      phase: 'cancelled',
      detail: 'Queued run was dropped before restart',
    });
  });

  it('ignores stale recovery records whose run no longer exists', () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    localRepo.listOpenRuns = () => [
      {
        id: 'missing',
        automationId: automation.id,
        source: 'scheduled',
        phase: 'acting',
        scheduledForAt: automation.nextRunAt,
        occurrenceKey: null,
        dedupeKey: 'missing',
        startedAt: new Date(time).toISOString(),
        dispatchedAt: new Date(time).toISOString(),
        endedAt: null,
        triggered: true,
        status: 'failed',
        detail: 'Running action',
        sessionId: null,
      },
    ];
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: { run: async () => okResult },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    expect(() => sched.resume()).not.toThrow();
    expect(localRepo.listRuns(automation.id)).toHaveLength(0);
  });

  it('recovers an acting run even when its automation record is already gone', () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Missing owner',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    localRepo.appendRun({
      id: 'missing-owner-run',
      automationId: automation.id,
      source: 'scheduled',
      phase: 'acting',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `scheduled:${automation.id}:${automation.nextRunAt}`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: new Date(time).toISOString(),
      endedAt: null,
      triggered: true,
      status: 'failed',
      detail: 'Running action',
      sessionId: null,
    });
    const originalGet = localRepo.get;
    localRepo.get = (id) => (id === automation.id ? null : originalGet(id));

    createAutomationScheduler({
      repo: localRepo,
      checks: checkReturning(okResult),
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    }).resume();

    expect(localRepo.getRun('missing-owner-run')).toMatchObject({
      phase: 'uncertain',
      status: 'failed',
    });
  });

  it('marks a recovered acting short monitor failed without replaying it', () => {
    const automation = service.runNow(
      service.create({
        name: 'Short one-shot',
        mode: 'short',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    repo.appendRun({
      id: 'short-acting',
      automationId: automation.id,
      source: 'scheduled',
      phase: 'acting',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `scheduled:${automation.id}:${automation.nextRunAt}`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: new Date(time).toISOString(),
      endedAt: null,
      triggered: true,
      status: 'failed',
      detail: 'Running action',
      sessionId: null,
    });

    scheduler(checkReturning(okResult), actionReturning(action)).resume();

    expect(repo.getRun('short-acting')).toMatchObject({
      phase: 'uncertain',
      status: 'failed',
    });
    expect(service.get(automation.id)).toMatchObject({
      status: 'failed',
      nextRunAt: null,
      failure:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });
  });

  it('settles an aborted acting run even when its automation record disappears', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Missing during abort',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: checkReturning(okResult),
      actions: {
        run: async (_spec, ctx) =>
          new Promise<ActionResult>((_resolve, reject) => {
            ctx.signal?.addEventListener(
              'abort',
              () => reject(new Error('Meta request cancelled')),
              { once: true },
            );
          }),
      },
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    const running = sched.tick();
    await Promise.resolve();
    const originalGet = localRepo.get;
    localRepo.get = (id) => (id === automation.id ? null : originalGet(id));
    sched.abort(automation.id);
    await running;

    expect(localRepo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
      phase: 'uncertain',
      status: 'failed',
      }),
    );
  });

  it('kick rehydrates a persisted queued run when the in-memory admission is gone', async () => {
    const a = dueAutomation();
    repo.appendRun({
      id: 'queued-run',
      automationId: a.id,
      source: 'manual',
      phase: 'queued',
      scheduledForAt: a.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `manual:${a.id}:queued-run`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to run now',
      sessionId: null,
    });
    const checksRun = vi.fn(async () => okResult);
    const sched = scheduler(
      { run: checksRun },
      actionReturning(action),
      { maxConcurrentChecks: 1 },
    );

    sched.kick(a.id);
    await expect(sched.waitForIdle(100)).resolves.toBe(true);

    expect(checksRun).toHaveBeenCalledTimes(1);
    expect(repo.getRun('queued-run')).toMatchObject({
      phase: 'finished',
      status: 'ok',
    });
  });

  it('coalesces run-now with an already queued scheduled occurrence instead of replacing it', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    let resolveFirst!: () => void;
    const started: string[] = [];
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        started.push(ctx.automationId);
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        return okResult;
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    const running = sched.tick();
    await Promise.resolve();
    await sched.runNow(second.id);
    resolveFirst();
    await running;
    await expect(sched.waitForIdle(100)).resolves.toBe(true);

    expect(started).toEqual([first.id, second.id]);
    expect(repo.listRuns(second.id)).toEqual([
      expect.objectContaining({
        source: 'scheduled',
        phase: 'finished',
        detail: 'action ran',
      }),
    ]);
  });

  it('surfaces run-now admission failures and leaves no leaked ownership behind', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.create({
      name: 'Manual',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    const saveRun = localRepo.saveRun;
    localRepo.saveRun = (run) => {
      if (run.phase === 'checking') {
        throw new Error('claim failed');
      }
      saveRun(run);
    };
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: { run: async () => okResult },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await expect(sched.runNow(automation.id)).rejects.toThrow('claim failed');
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(localRepo.findOpenRun(automation.id)).toMatchObject({ phase: 'queued' });
  });

  it('rejects run-now for a missing automation', async () => {
    await expect(
      scheduler(checkReturning(okResult), actionReturning(action)).runNow('missing'),
    ).rejects.toThrow('Automation not found: missing');
  });

  it('rejects run-now for a finished automation', async () => {
    const automation = service.create({
      name: 'Done',
      mode: 'short',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    service.cancel(automation.id);

    await expect(
      scheduler(checkReturning(okResult), actionReturning(action)).runNow(automation.id),
    ).rejects.toThrow(`Automation is already finished: ${automation.id}`);
  });

  it('reactivates a paused automation when run-now coalesces with an existing queued run', async () => {
    const automation = service.create({
      name: 'Paused',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    service.pause(automation.id);
    repo.appendRun({
      id: 'paused-queued',
      automationId: automation.id,
      source: 'manual',
      phase: 'queued',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `manual:${automation.id}:paused-queued`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to run now',
      sessionId: null,
    });
    const sched = scheduler(checkReturning(okResult), actionReturning(action));

    const result = await sched.runNow(automation.id);

    expect(result.id).toBe(automation.id);
    expect(result.status).toBe('active');
    expect(service.get(automation.id)).toMatchObject({
      status: 'active',
    });
    expect(repo.listRuns(automation.id)).toHaveLength(1);
    expect(repo.getRun('paused-queued')).toMatchObject({
      phase: 'finished',
      source: 'manual',
    });
  });

  it('preserves automation progress when run-now coalesces with an in-flight run that has no detail', async () => {
    const automation = service.create({
      name: 'Paused',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    repo.save({ ...automation, progress: 'Existing progress' });
    repo.appendRun({
      id: 'checking-no-detail',
      automationId: automation.id,
      source: 'manual',
      phase: 'checking',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `manual:${automation.id}:checking-no-detail`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: new Date(time).toISOString(),
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: null,
      sessionId: null,
    });

    const result = await scheduler(
      checkReturning(okResult),
      actionReturning(action),
    ).runNow(automation.id);

    expect(result.progress).toBe('Existing progress');
    expect(repo.listRuns(automation.id)).toHaveLength(1);
  });

  it('returns the last reserved automation snapshot if run-now completes after the record disappears', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.create({
      name: 'Transient',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: {
        run: async () => {
          const originalGet = localRepo.get;
          localRepo.get = (id) => (id === automation.id ? null : originalGet(id));
          return okResult;
        },
      },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    const result = await sched.runNow(automation.id);

    expect(result).toMatchObject({ id: automation.id, status: 'active' });
  });

  it('surfaces kick admission failures for a recovered queued run', async () => {
    const a = dueAutomation();
    repo.appendRun({
      id: 'queued-run-fail',
      automationId: a.id,
      source: 'manual',
      phase: 'queued',
      scheduledForAt: a.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `manual:${a.id}:queued-run-fail`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to run now',
      sessionId: null,
    });
    const saveRun = repo.saveRun;
    repo.saveRun = (run) => {
      if (run.id === 'queued-run-fail' && run.phase === 'checking') {
        throw new Error('kick claim failed');
      }
      saveRun(run);
    };
    const sched = scheduler(checkReturning(okResult), actionReturning(action));

    await expect(sched.kick(a.id)).rejects.toThrow('kick claim failed');
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(repo.getRun('queued-run-fail')).toMatchObject({ phase: 'queued' });
  });

  it('reports admission failures through onError when configured', async () => {
    const automation = service.create({
      name: 'Manual',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    const onError = vi.fn();
    const saveRun = repo.saveRun;
    repo.saveRun = (run) => {
      if (run.phase === 'checking') {
        throw new Error('claim failed');
      }
      saveRun(run);
    };
    const sched = createAutomationScheduler({
      repo,
      checks: checkReturning(okResult),
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
      onError,
    });

    await expect(sched.runNow(automation.id)).rejects.toThrow('claim failed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'claim failed' }));
  });

  it('revalidates a queued scheduled run after settings change and drops the stale occurrence', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    let resolveFirst!: () => void;
    const started: string[] = [];
    const checks: CheckRunner = {
      run: async (_spec, ctx) => {
        started.push(ctx.automationId);
        if (ctx.automationId === first.id) {
          return new Promise<CheckResult>((resolve) => {
            resolveFirst = () => resolve({ ...okResult, status: 'in_progress' });
          });
        }
        return okResult;
      },
    };
    const sched = scheduler(checks, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    const running = sched.tick();
    await Promise.resolve();
    service.updateInterval(second.id, 120_000);
    resolveFirst();
    await running;

    expect(started).toEqual([first.id]);
    expect(repo.listRuns(second.id)).toContainEqual(
      expect.objectContaining({
        phase: 'cancelled',
        detail: 'Run cancelled before dispatch',
      }),
    );
  });

  it('ignores tick and kick after shutdown', async () => {
    const a = dueAutomation();
    let checksRun = 0;
    const checks: CheckRunner = {
      run: async () => {
        checksRun += 1;
        return okResult;
      },
    };
    const sched = scheduler(checks, actionReturning(action));
    sched.shutdown();
    await sched.tick();
    sched.kick(a.id);
    await Promise.resolve();
    expect(checksRun).toBe(0);
  });

  it('start schedules ticks and stop clears the loop (idempotent)', () => {
    vi.useFakeTimers();
    try {
      const sched = scheduler(checkReturning(okResult), actionReturning(action));
      const tickSpy = vi.spyOn(sched, 'tick').mockResolvedValue();
      sched.start();
      sched.start(); // no-op second call
      vi.advanceTimersByTime(10_000);
      expect(tickSpy).toHaveBeenCalledTimes(1);
      sched.stop();
      sched.stop(); // no-op second call
      vi.advanceTimersByTime(20_000);
      expect(tickSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports background tick failures through the scheduler error hook', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const sched = createAutomationScheduler({
        repo,
        checks: checkReturning(okResult),
        actions: actionReturning(action),
        clock: createClock(() => time),
        ids: counterIds(),
        bus,
        config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
        onError,
      });
      vi.spyOn(sched, 'tick').mockRejectedValue(new Error('tick failed'));

      sched.start();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'tick failed' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects run-now after shutdown closes new admissions', async () => {
    const automation = service.create({
      name: 'Manual',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    const sched = scheduler(checkReturning(okResult), actionReturning(action));

    sched.shutdown();

    await expect(sched.runNow(automation.id)).rejects.toThrow(
      'Automation scheduler is shut down',
    );
  });

  it('rejects acknowledged run-now when a queued scheduled run already owns the monitor', async () => {
    const first = dueAutomation({ name: 'A' });
    const second = dueAutomation({ name: 'B' });
    repo.appendRun({
      id: `uncertain-${second.id}`,
      automationId: second.id,
      source: 'scheduled',
      phase: 'uncertain',
      scheduledForAt: second.nextRunAt,
      occurrenceKey: 'run-b',
      dedupeKey: `scheduled:${second.id}:uncertain-${second.id}`,
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
      report: null,
    });
    let releaseFirst!: () => void;
    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const sched = scheduler(
      {
        run: async (_spec, ctx) =>
          new Promise<CheckResult>((resolve) => {
            if (ctx.automationId === first.id) {
              releaseFirst = () =>
                resolve({ ...okResult, occurrenceKey: 'run-a' });
              return;
            }
            resolve({ ...okResult, occurrenceKey: 'run-b' });
          }),
      },
      { run: actionsRun },
      { maxConcurrentChecks: 1 },
    );

    const ticking = sched.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(repo.findOpenRun(second.id)).toMatchObject({
      source: 'scheduled',
      phase: 'queued',
    });

    await expect(
      sched.runNow(second.id, {
        acknowledgement: {
          snapshotRunIds: [`uncertain-${second.id}`],
          targetRunIds: [`uncertain-${second.id}`],
        },
      }),
    ).rejects.toThrow(/queued scheduled run/i);

    releaseFirst();
    await ticking;
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(actionsRun).toHaveBeenCalledTimes(1);
  });

  it('rejects acknowledged run-now when a running scheduled run already owns the monitor', async () => {
    const automation = dueAutomation({ name: 'B' });
    repo.appendRun({
      id: `uncertain-${automation.id}`,
      automationId: automation.id,
      source: 'scheduled',
      phase: 'uncertain',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: 'run-b',
      dedupeKey: `scheduled:${automation.id}:uncertain-${automation.id}`,
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
      report: null,
    });
    let release!: () => void;
    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const sched = scheduler(
      {
        run: async () =>
          new Promise<CheckResult>((resolve) => {
            release = () => resolve({ ...okResult, occurrenceKey: 'run-b' });
          }),
      },
      { run: actionsRun },
      { maxConcurrentChecks: 1 },
    );

    const ticking = sched.tick();
    await Promise.resolve();

    expect(repo.findOpenRun(automation.id)).toMatchObject({
      source: 'scheduled',
      phase: 'checking',
    });

    await expect(
      sched.runNow(automation.id, {
        acknowledgement: {
          snapshotRunIds: [`uncertain-${automation.id}`],
          targetRunIds: [`uncertain-${automation.id}`],
        },
      }),
    ).rejects.toThrow(/running scheduled run/i);

    release();
    await ticking;
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(actionsRun).not.toHaveBeenCalled();
  });

  it('waitForIdle resolves true immediately when nothing is running', async () => {
    await expect(
      scheduler(checkReturning(okResult), actionReturning(action)).waitForIdle(1),
    ).resolves.toBe(true);
  });

  it('waitForIdle times out once and ignores the later idle notification', async () => {
    vi.useFakeTimers();
    try {
      const a = dueAutomation();
      let resolveCheck!: () => void;
      const checks: CheckRunner = {
        run: async () =>
          new Promise<CheckResult>((resolve) => {
            resolveCheck = () => resolve({ ...okResult, status: 'in_progress' });
          }),
      };
      const sched = scheduler(checks, actionReturning(action));
      const running = sched.tick();
      await Promise.resolve();
      const waiting = sched.waitForIdle(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBe(false);
      resolveCheck();
      await running;
      expect(service.get(a.id).status).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForIdle ignores a later timeout callback after the scheduler already became idle', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    try {
      const a = dueAutomation();
      let resolveCheck!: () => void;
      const checks: CheckRunner = {
        run: async () =>
          new Promise<CheckResult>((resolve) => {
            resolveCheck = () => resolve({ ...okResult, status: 'in_progress' });
          }),
      };
      const sched = scheduler(checks, actionReturning(action));
      sched.kick(a.id);
      await Promise.resolve();
      await Promise.resolve();
      const waiting = sched.waitForIdle(1);
      resolveCheck();
      await expect(waiting).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('surfaces final persistence failures without replaying the in-flight run, and still releases admission ownership', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const saveRun = localRepo.saveRun;
    localRepo.saveRun = (run) => {
      if (run.phase === 'finished') {
        throw new Error('disk full');
      }
      saveRun(run);
    };
    let checksRun = 0;
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: {
        run: async () => {
          checksRun += 1;
          return okResult;
        },
      },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await expect(sched.tick()).rejects.toThrow('disk full');
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(localRepo.findOpenRun(automation.id)).toMatchObject({
      phase: 'acting',
      detail: 'Running action',
    });

    await sched.kick(automation.id);
    await Promise.resolve();
    expect(checksRun).toBe(1);
  });

  it('releases admission ownership when dispatch intent persistence fails before the check starts', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const saveRun = localRepo.saveRun;
    let failClaim = true;
    localRepo.saveRun = (run) => {
      if (failClaim && run.phase === 'checking') {
        throw new Error('claim failed');
      }
      saveRun(run);
    };
    const checksRun = vi.fn(async () => okResult);
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: { run: checksRun },
      actions: actionReturning(action),
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await expect(sched.tick()).rejects.toThrow('claim failed');
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(checksRun).not.toHaveBeenCalled();
    expect(localRepo.findOpenRun(automation.id)).toMatchObject({ phase: 'queued' });

    failClaim = false;
    await sched.kick(automation.id);
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(checksRun).toHaveBeenCalledTimes(1);
    expect(localRepo.getRun(automation.id)).toMatchObject({ phase: 'finished' });
  });

  it('releases ownership cleanly when the run disappears before final success persistence', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalGetRun = localRepo.getRun.bind(localRepo);
    let dropRun = false;
    localRepo.getRun = (id) => (dropRun ? null : originalGetRun(id));
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: { run: async () => okResult },
      actions: {
        run: async () => {
          dropRun = true;
          return action;
        },
      },
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);
    expect(localRepo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({ phase: 'acting' }),
    );
  });

  it('rechecks liveness before beginning the action and cancels when the automation changed', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalGet = localRepo.get.bind(localRepo);
    let postCheckGets = 0;
    let checkCompleted = false;
    localRepo.get = (id) => {
      const current = originalGet(id);
      if (id !== automation.id || current === null || !checkCompleted) {
        return current;
      }
      postCheckGets += 1;
      if (postCheckGets >= 3) {
        return { ...current, status: 'paused', nextRunAt: null };
      }
      return current;
    };
    const actionsRun = vi.fn(async () => action);
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: {
        run: async () => {
          checkCompleted = true;
          return okResult;
        },
      },
      actions: { run: actionsRun },
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(actionsRun).not.toHaveBeenCalled();
    expect(localRepo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'cancelled',
        detail: 'Run cancelled before completion',
      }),
    );
  });

  it('cancels the run when its persisted phase changed before the action began', async () => {
    const localRepo = fakeRepo();
    const localBus = createEventBus<AutomationEventMap>();
    const localService = createAutomationService({
      repo: localRepo,
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: {
        defaultIntervalMs: 60_000,
        minIntervalMs: 10_000,
        maxActiveAutomations: 50,
      },
    });
    const automation = localService.runNow(
      localService.create({
        name: 'Monitor',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'status-equals', value: 'completed' },
        action: { type: 'report', prompt: 'go' },
      }).id,
    );
    const originalSaveRun = localRepo.saveRun.bind(localRepo);
    localRepo.saveRun = (run) => {
      if (run.phase === 'checking') {
        originalSaveRun({ ...run, phase: 'finished' });
        return;
      }
      originalSaveRun(run);
    };
    const actionsRun = vi.fn(async () => action);
    const sched = createAutomationScheduler({
      repo: localRepo,
      checks: { run: async () => okResult },
      actions: { run: actionsRun },
      clock: createClock(() => time),
      ids: counterIds(),
      bus: localBus,
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 1 },
    });

    await sched.tick();

    expect(actionsRun).not.toHaveBeenCalled();
    expect(localRepo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'skipped',
        detail: 'Checking now',
      }),
    );
  });

  it('prioritizes a recovered manual run ahead of older queued work', async () => {
    const first = dueAutomation({ name: 'First' });
    const second = dueAutomation({ name: 'Second' });
    const manual = service.create({
      name: 'Manual retry',
      mode: 'long',
      check: { type: 'shell', command: 'echo' },
      condition: { type: 'status-equals', value: 'completed' },
      action: { type: 'report', prompt: 'go' },
    });
    service.pause(manual.id);
    repo.appendRun({
      id: 'manual-queued',
      automationId: manual.id,
      source: 'manual',
      phase: 'queued',
      scheduledForAt: null,
      occurrenceKey: null,
      dedupeKey: `manual:${manual.id}:manual-queued`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to run now',
      sessionId: null,
    });

    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sched = scheduler(
      {
        run: async (_spec, ctx) => {
          started.push(ctx.automationId);
          if (ctx.automationId === first.id) {
            await firstGate;
          }
          return { ...okResult, occurrenceKey: ctx.automationId };
        },
      },
      actionReturning(action),
      { maxConcurrentChecks: 1 },
    );

    const ticking = sched.tick();
    await Promise.resolve();
    await Promise.resolve();
    const runNow = sched.runNow(manual.id);
    await Promise.resolve();
    releaseFirst();

    await ticking;
    await runNow;
    await expect(sched.waitForIdle(100)).resolves.toBe(true);

    expect(started).toEqual([first.id, manual.id, second.id]);
  });

  it('requeues a persisted queued run on resume with a fresh admission', async () => {
    const automation = dueAutomation();
    repo.appendRun({
      id: 'persisted-queued',
      automationId: automation.id,
      source: 'scheduled',
      phase: 'queued',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `scheduled:${automation.id}:${automation.nextRunAt}`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to check',
      sessionId: null,
    });
    const checksRun = vi.fn(async () => okResult);
    const sched = scheduler({ run: checksRun }, actionReturning(action), {
      maxConcurrentChecks: 1,
    });

    sched.resume();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);

    expect(checksRun).toHaveBeenCalledTimes(1);
    expect(repo.getRun('persisted-queued')).toMatchObject({
      phase: 'finished',
      status: 'ok',
    });
  });

  it('falls back to the full uncertainty set when a scheduled run carries a stale acknowledgement', async () => {
    const automation = dueAutomation();
    const uncertain = {
      id: 'uncertain-known',
      automationId: automation.id,
      source: 'scheduled' as const,
      phase: 'uncertain' as const,
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: 'run-1',
      dedupeKey: `scheduled:${automation.id}:uncertain-known`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: new Date(time).toISOString(),
      endedAt: new Date(time).toISOString(),
      triggered: true,
      status: 'failed' as const,
      detail:
        'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      sessionId: null,
      acknowledgedRunIds: null,
      acknowledgedSnapshotRunIds: null,
      resolvedByRunId: null,
    };
    repo.appendRun({
      id: 'scheduled-queued',
      automationId: automation.id,
      source: 'scheduled',
      phase: 'queued',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `scheduled:${automation.id}:${automation.nextRunAt}`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to check',
      sessionId: null,
      acknowledgedRunIds: ['uncertain-known'],
      acknowledgedSnapshotRunIds: ['uncertain-known'],
      resolvedByRunId: null,
    });
    repo.listPendingUncertainRuns = () => [uncertain];
    const sched = scheduler(
      checkReturning({ ...okResult, occurrenceKey: 'run-1' }),
      actionReturning(action),
      { maxConcurrentChecks: 1 },
    );

    sched.resume();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);

    expect(repo.getRun('scheduled-queued')).toMatchObject({
      phase: 'finished',
      detail:
        'Automatic action replay is blocked for occurrence "run-1" because a previous attempt may already have run. Use Run now only if you intend to retry it.',
    });
  });

  it('falls back to the current uncertainty set when a scheduled retry cannot re-identify the occurrence', async () => {
    const automation = dueAutomation();
    const uncertain = {
      id: 'uncertain-known',
      automationId: automation.id,
      source: 'scheduled' as const,
      phase: 'uncertain' as const,
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: 'run-1',
      dedupeKey: `scheduled:${automation.id}:uncertain-known`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: new Date(time).toISOString(),
      endedAt: new Date(time).toISOString(),
      triggered: true,
      status: 'failed' as const,
      detail:
        'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      sessionId: null,
      acknowledgedRunIds: null,
      acknowledgedSnapshotRunIds: null,
      resolvedByRunId: null,
    };
    repo.appendRun({
      id: 'scheduled-queued-null',
      automationId: automation.id,
      source: 'scheduled',
      phase: 'queued',
      scheduledForAt: automation.nextRunAt,
      occurrenceKey: null,
      dedupeKey: `scheduled:${automation.id}:${automation.nextRunAt}:null`,
      startedAt: new Date(time).toISOString(),
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to check',
      sessionId: null,
      acknowledgedRunIds: ['uncertain-known'],
      acknowledgedSnapshotRunIds: ['uncertain-known'],
      resolvedByRunId: null,
    });
    repo.listPendingUncertainRuns = () => [uncertain];
    const sched = scheduler(
      checkReturning({ ...okResult, occurrenceKey: null }),
      actionReturning(action),
      { maxConcurrentChecks: 1 },
    );

    sched.resume();
    await expect(sched.waitForIdle(100)).resolves.toBe(true);

    expect(repo.getRun('scheduled-queued-null')).toMatchObject({
      phase: 'finished',
      detail:
        'Automatic action replay is blocked for occurrence "run-1" because a previous attempt may already have run. Use Run now only if you intend to retry it.',
    });
  });

  it('ignores defensive self-matches while reconciling uncertainty after a successful retry', async () => {
    const automation = dueAutomation();
    const originalPending = repo.listPendingUncertainRuns.bind(repo);
    repo.listPendingUncertainRuns = (automationId) => {
      const syntheticCurrent = repo
        .listRuns(automationId)
        .find((item) => item.source === 'manual' && item.phase === 'acting');
      return syntheticCurrent === undefined
        ? originalPending(automationId)
        : [
            {
              ...syntheticCurrent,
              phase: 'uncertain',
              triggered: true,
              status: 'failed',
            },
          ];
    };

    await scheduler(
      checkReturning({ ...okResult, occurrenceKey: 'run-1' }),
      actionReturning(action),
    ).runNow(automation.id);

    expect(repo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        source: 'manual',
        phase: 'finished',
        status: 'ok',
      }),
    );
  });
});
