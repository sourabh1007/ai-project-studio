import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import { createAutomationService } from './automation-service.js';
import type {
  AutomationEventMap,
  CreateAutomationInput,
} from './automation-service.js';
import { createAutomationScheduler } from './automation-scheduler.js';
import type {
  ActionResult,
  Automation,
  AutomationRepo,
  AutomationRun,
  CheckResult,
  CheckRunner,
  ActionRunner,
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
    },
    appendRun(r) {
      runs.push(r);
    },
    listRuns(id) {
      return runs.filter((r) => r.automationId === id);
    },
  };
}

function counterIds() {
  let n = 0;
  return { next: () => `id${++n}` };
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

  beforeEach(() => {
    repo = fakeRepo();
    time = Date.UTC(2026, 0, 1);
    const bus = createEventBus<AutomationEventMap>();
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

  function scheduler(checks: CheckRunner, actions: ActionRunner) {
    return createAutomationScheduler({
      service,
      repo,
      checks,
      actions,
      clock: createClock(() => time),
      ids: counterIds(),
      config: { minIntervalMs: 10_000, maxConcurrentChecks: 2 },
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
    expect(service.get(a.id).progress).toBe('Waiting · pending output');
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
    expect(after.progress).toContain('Waiting');
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

  it('does not throw or save when a monitor is deleted mid-check', async () => {
    const a = dueAutomation();
    const checks: CheckRunner = {
      run: async () => {
        service.remove(a.id);
        return { ...okResult, status: 'in_progress' };
      },
    };
    await expect(
      scheduler(checks, actionReturning(action)).tick(),
    ).resolves.toBeUndefined();
    expect(service.list().some((x) => x.id === a.id)).toBe(false);
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
});
