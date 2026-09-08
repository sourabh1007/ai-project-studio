import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createAutomationRepo } from '../persistence/automation-repo.js';
import type {
  ActionRunner,
  Automation,
  AutomationRun,
  CheckResult,
  CheckRunner,
} from './automation-contract.js';
import {
  createAutomationService,
  type AutomationEventMap,
  type CreateAutomationInput,
} from './automation-service.js';
import { createAutomationScheduler } from './automation-scheduler.js';

function counterIds() {
  let n = 0;
  return { next: () => `id${++n}` };
}

const okResult: CheckResult = {
  code: 0,
  status: 'completed',
  conclusion: 'success',
  text: 'ok',
  occurrenceKey: 'run-1',
};

function baseInput(overrides: Partial<CreateAutomationInput> = {}): CreateAutomationInput {
  return {
    name: 'Monitor',
    mode: 'long',
    check: { type: 'shell', command: 'echo' },
    condition: { type: 'status-equals', value: 'completed' },
    action: { type: 'report', prompt: 'go' },
    ...overrides,
  };
}

describe('automation-scheduler persistence', () => {
  const dbs: { close(): void }[] = [];

  afterEach(() => {
    while (dbs.length > 0) {
      dbs.pop()?.close();
    }
  });

  function createHarness() {
    let time = Date.UTC(2026, 0, 1);
    const clock = createClock(() => time);
    const bus = createEventBus<AutomationEventMap>();
    const db = createDatabase({ databasePath: ':memory:' });
    dbs.push(db);
    const repo = createAutomationRepo(db);
    const ids = counterIds();
    const schedulerIds = counterIds();
    const service = createAutomationService({
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
    const scheduler = (
      checks: CheckRunner,
      actions: ActionRunner,
      config: Partial<{ maxConcurrentChecks: number }> = {},
    ) =>
      createAutomationScheduler({
        repo,
        checks,
        actions,
        clock,
        ids: schedulerIds,
        bus,
        config: {
          minIntervalMs: 10_000,
          maxConcurrentChecks: config.maxConcurrentChecks ?? 1,
        },
      });
    const dueAutomation = (overrides: Partial<CreateAutomationInput> = {}): Automation =>
      service.runNow(service.create(baseInput(overrides)).id);
    const run = (automation: Automation, overrides: Partial<AutomationRun> = {}): AutomationRun => ({
      id: `run-${automation.id}`,
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
      report: null,
      ...overrides,
    });
    return { repo, service, scheduler, dueAutomation, run, advance: (ms: number) => (time += ms) };
  }

  it('resumes a persisted queued occurrence after restart and dispatches it once', async () => {
    const { repo, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(run(automation));

    const checksRun = vi.fn(async () => okResult);
    const actionsRun = vi.fn(async () => ({
      detail: 'Report generated',
      sessionId: 'm1',
      subagentId: null,
      report: 'ready',
    }));

    const resumed = scheduler({ run: checksRun }, { run: actionsRun });
    resumed.resume();

    await expect(resumed.waitForIdle(100)).resolves.toBe(true);
    expect(checksRun).toHaveBeenCalledTimes(1);
    expect(actionsRun).toHaveBeenCalledTimes(1);
    expect(repo.getRun(`run-${automation.id}`)).toMatchObject({
      phase: 'finished',
      status: 'ok',
      occurrenceKey: 'run-1',
      report: 'ready',
    });
  });

  it('marks a persisted dispatched occurrence uncertain on resume and does not replay it', async () => {
    const { repo, service, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    advance(5_000);
    repo.appendRun(
      run(automation, {
        phase: 'acting',
        dispatchedAt: '2026-01-01T00:00:02.000Z',
        triggered: true,
        detail: 'Running action',
      }),
    );

    const checksRun = vi.fn(async () => okResult);
    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));

    const resumed = scheduler({ run: checksRun }, { run: actionsRun });
    resumed.resume();

    expect(checksRun).not.toHaveBeenCalled();
    expect(actionsRun).not.toHaveBeenCalled();
    expect(repo.getRun(`run-${automation.id}`)).toMatchObject({
      phase: 'uncertain',
      status: 'failed',
      detail:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });
    expect(service.get(automation.id)).toMatchObject({
      status: 'active',
      progress:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      nextRunAt: '2026-01-01T00:01:05.000Z',
    });
  });

  it('keeps an interrupted short monitor active after resume when no action was dispatched yet', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation({ mode: 'short' });
    repo.appendRun(
      run(automation, {
        phase: 'checking',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        detail: 'Checking now',
      }),
    );

    const resumed = scheduler(
      { run: vi.fn(async () => okResult) },
      {
        run: vi.fn(async () => ({
          detail: 'should not run',
          sessionId: null,
          subagentId: null,
          report: null,
        })),
      },
    );
    resumed.resume();

    expect(repo.getRun(`run-${automation.id}`)).toMatchObject({
      phase: 'interrupted',
      status: 'skipped',
    });
    expect(service.get(automation.id)).toMatchObject({
      status: 'active',
      nextRunAt: '2026-01-01T00:01:00.000Z',
      failure: null,
    });
  });

  it('marks stale in-flight runs uncertain without reviving a cancelled automation', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation();
    service.cancel(automation.id);
    repo.appendRun(
      run(automation, {
        phase: 'acting',
        dispatchedAt: '2026-01-01T00:00:00.000Z',
        triggered: true,
        detail: 'Running action',
      }),
    );

    const resumed = scheduler(
      { run: vi.fn(async () => okResult) },
      {
        run: vi.fn(async () => ({
          detail: 'should not run',
          sessionId: null,
          subagentId: null,
          report: null,
        })),
      },
    );
    resumed.resume();

    expect(repo.getRun(`run-${automation.id}`)).toMatchObject({
      phase: 'uncertain',
      status: 'failed',
    });
    expect(service.get(automation.id)).toMatchObject({
      status: 'cancelled',
      nextRunAt: null,
    });
  });

  it('blocks automatic replay after an action may have run but its final result was not persisted', async () => {
    const { repo, service, scheduler, dueAutomation, advance } = createHarness();
    const automation = dueAutomation();
    let effects = 0;
    const saveRun = repo.saveRun.bind(repo);
    let failFinishedPersistence = true;
    repo.saveRun = (run) => {
      if (failFinishedPersistence && run.phase === 'finished') {
        throw new Error('disk full');
      }
      saveRun(run);
    };

    const first = scheduler(
      { run: vi.fn(async () => okResult) },
      {
        run: vi.fn(async () => {
          effects += 1;
          return {
            detail: 'Report generated',
            sessionId: 'm1',
            subagentId: null,
            report: 'ready',
          };
        }),
      },
    );

    await expect(first.tick()).rejects.toThrow('disk full');
    await expect(first.waitForIdle(100)).resolves.toBe(true);
    expect(repo.findOpenRun(automation.id)).toMatchObject({ phase: 'acting' });
    expect(effects).toBe(1);

    failFinishedPersistence = false;
    const resumed = scheduler(
      { run: vi.fn(async () => okResult) },
      {
        run: vi.fn(async () => {
          effects += 1;
          return {
            detail: 'should not rerun automatically',
            sessionId: null,
            subagentId: null,
            report: null,
          };
        }),
      },
    );
    resumed.resume();
    advance(60_000);
    await resumed.tick();
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(effects).toBe(1);
    expect(repo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'ok',
        detail:
          'Automatic action replay is blocked for occurrence "run-1" because a previous attempt may already have run. Use Run now only if you intend to retry it.',
      }),
    );
    expect(service.get(automation.id).progress).toBe(
      'Waiting for status "completed" · last result: completed',
    );
  });

  it('fails closed for automatic replays when the uncertain action occurrence identity is unknown', async () => {
    const { repo, service, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'uncertain',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:05.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );

    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
      { run: actionsRun },
    );

    advance(60_000);
    await resumed.tick();
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).not.toHaveBeenCalled();
    expect(repo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'ok',
        detail:
          'Automatic action replay is blocked because a previous action may already have run and its occurrence identity is unknown. Use Run now only if you intend to retry it.',
      }),
    );
    expect(service.get(automation.id).runCount).toBe(0);
  });

  it('synthesizes the unknown uncertainty detail when a legacy uncertain run has no saved detail', async () => {
    const { repo, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'unknown-no-detail',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:05.000Z',
        detail: null,
      }),
    );
    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
      { run: actionsRun },
    );

    advance(60_000);
    await resumed.tick();

    expect(actionsRun).not.toHaveBeenCalled();
  });

  it('does not let an already resolved uncertain occurrence block later scheduled occurrences', async () => {
    const { repo, service, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'older-uncertain',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.appendRun(
      run(automation, {
        id: 'resolved-success',
        phase: 'finished',
        triggered: true,
        status: 'ok',
        occurrenceKey: 'run-1',
        startedAt: '2026-01-01T00:00:02.000Z',
        dispatchedAt: '2026-01-01T00:00:02.000Z',
        endedAt: '2026-01-01T00:00:03.000Z',
        detail: 'action ran',
      }),
    );
    repo.save({
      ...service.get(automation.id),
      lastOccurrenceKey: 'run-1',
      runCount: 1,
    });

    const actionsRun = vi.fn(async () => ({
      detail: 'Report generated',
      sessionId: 'm2',
      subagentId: null,
      report: 'ready',
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
      { run: actionsRun },
    );

    advance(60_000);
    await resumed.tick();
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).toHaveBeenCalledTimes(1);
    expect(service.get(automation.id).runCount).toBe(2);
  });

  it('synthesizes the known uncertainty detail when a legacy uncertain run has no saved detail', async () => {
    const { repo, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'known-no-detail',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-1',
        endedAt: '2026-01-01T00:00:05.000Z',
        detail: null,
      }),
    );
    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-1' })) },
      { run: actionsRun },
    );

    advance(60_000);
    await resumed.tick();

    expect(actionsRun).not.toHaveBeenCalled();
  });

  it('does not treat finished runs without an occurrence key as resolving an uncertain occurrence', async () => {
    const { repo, service, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'finished-without-key',
        phase: 'finished',
        triggered: true,
        status: 'ok',
        occurrenceKey: null,
        startedAt: '2026-01-01T00:00:03.000Z',
        dispatchedAt: '2026-01-01T00:00:03.000Z',
        endedAt: '2026-01-01T00:00:04.000Z',
        detail: 'completed without key',
      }),
    );
    repo.appendRun(
      run(automation, {
        id: 'older-uncertain-known',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.save({
      ...service.get(automation.id),
      lastOccurrenceKey: 'run-1',
      runCount: 1,
    });
    const actionsRun = vi.fn(async () => ({
      detail: 'should not rerun',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-1' })) },
      { run: actionsRun },
    );

    advance(60_000);
    await resumed.tick();
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).not.toHaveBeenCalled();
    expect(repo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'ok',
        detail: 'Checked: completed',
      }),
    );
  });

  it('preserves older unresolved occurrences even after newer uncertain attempts exist', async () => {
    const { repo, service, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'uncertain-a',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.appendRun(
      run(automation, {
        id: 'uncertain-b',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-2',
        startedAt: '2026-01-01T00:00:02.000Z',
        endedAt: '2026-01-01T00:00:03.000Z',
        detail:
          'Previous action may have already run for occurrence "run-2". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );

    const actionsRun = vi.fn(async () => ({
      detail: 'should not rerun automatically',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-1' })) },
      { run: actionsRun },
    );

    advance(60_000);
    await resumed.tick();
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).not.toHaveBeenCalled();
    expect(service.get(automation.id).uncertainty?.unresolvedRunIds).toEqual(
      expect.arrayContaining(['uncertain-a', 'uncertain-b']),
    );
    expect(repo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'ok',
        occurrenceKey: 'run-1',
        detail:
          'Automatic action replay is blocked for occurrence "run-1" because a previous attempt may already have run. Use Run now only if you intend to retry it.',
      }),
    );
  });

  it('keeps unknown uncertainty blocking automatic dispatch even when a newer known occurrence exists', async () => {
    const { repo, service, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'unknown-older',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.appendRun(
      run(automation, {
        id: 'known-newer',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-2',
        startedAt: '2026-01-01T00:00:02.000Z',
        endedAt: '2026-01-01T00:00:03.000Z',
        detail:
          'Previous action may have already run for occurrence "run-2". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );

    const actionsRun = vi.fn(async () => ({
      detail: 'should not rerun automatically',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
      { run: actionsRun },
    );

    advance(60_000);
    await resumed.tick();
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).not.toHaveBeenCalled();
    expect(service.get(automation.id).uncertainty?.unresolvedRunIds).toEqual(
      expect.arrayContaining(['unknown-older', 'known-newer']),
    );
    expect(repo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        status: 'ok',
        occurrenceKey: 'run-2',
        detail:
          'Automatic action replay is blocked because a previous action may already have run and its occurrence identity is unknown. Use Run now only if you intend to retry it.',
      }),
    );
  });

  it('re-admits an unowned queued manual run after claim persistence fails', async () => {
    const { repo, service, scheduler } = createHarness();
    const automation = service.create(baseInput());
    service.pause(automation.id);

    let failClaim = true;
    const saveRun = repo.saveRun.bind(repo);
    repo.saveRun = (currentRun) => {
      if (failClaim && currentRun.phase === 'checking') {
        failClaim = false;
        throw new Error('claim write failed');
      }
      saveRun(currentRun);
    };

    const checksRun = vi.fn(async () => okResult);
    const actionsRun = vi.fn(async () => ({
      detail: 'Report generated',
      sessionId: 'm1',
      subagentId: null,
      report: 'ready',
    }));
    const resumed = scheduler({ run: checksRun }, { run: actionsRun });

    await expect(resumed.runNow(automation.id)).rejects.toThrow('claim write failed');
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);
    expect(repo.findOpenRun(automation.id)).toMatchObject({
      source: 'manual',
      phase: 'queued',
    });

    await resumed.runNow(automation.id);
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).toHaveBeenCalledTimes(1);
    expect(checksRun).toHaveBeenCalledTimes(1);
    expect(repo.listRuns(automation.id).filter((item) => item.source === 'manual')).toHaveLength(1);
    expect(repo.findOpenRun(automation.id)).toBeNull();
    expect(service.get(automation.id).status).toBe('active');
  });

  it('requires a fresh acknowledgement before retrying uncertain short monitors', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation({ mode: 'short' });
    repo.appendRun(
      run(automation, {
        id: 'uncertain-short',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.save({
      ...service.get(automation.id),
      status: 'failed',
      nextRunAt: null,
      failure:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      progress:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });

    const actionsRun = vi.fn(async () => ({
      detail: 'Report generated',
      sessionId: 'm1',
      subagentId: null,
      report: 'ready',
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
      { run: actionsRun },
    );

    await expect(resumed.runNow(automation.id)).rejects.toThrow(
      /explicitly confirm a retry/i,
    );
    await expect(
      resumed.runNow(automation.id, {
        acknowledgement: {
          snapshotRunIds: ['uncertain-short'],
          targetRunIds: ['uncertain-short'],
        },
      }),
    ).resolves.toMatchObject({
      id: automation.id,
    });
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).toHaveBeenCalledTimes(1);
    expect(repo.getRun('uncertain-short')).toMatchObject({
      resolvedByRunId: expect.any(String),
    });
    expect(service.get(automation.id).status).toBe('completed');
    expect(service.get(automation.id).uncertainty).toBeUndefined();
  });

  it('re-admits an unowned acknowledged manual retry after its claim write fails', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation({ mode: 'short' });
    repo.appendRun(
      run(automation, {
        id: 'uncertain-short',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.save({
      ...service.get(automation.id),
      status: 'failed',
      nextRunAt: null,
      failure:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      progress:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });

    let failClaim = true;
    const saveRun = repo.saveRun.bind(repo);
    repo.saveRun = (currentRun) => {
      if (failClaim && currentRun.phase === 'checking') {
        failClaim = false;
        throw new Error('claim write failed');
      }
      saveRun(currentRun);
    };

    const actionsRun = vi.fn(async () => ({
      detail: 'Report generated',
      sessionId: 'm1',
      subagentId: null,
      report: 'ready',
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
      { run: actionsRun },
    );
    const acknowledgement = {
      acknowledgement: {
        snapshotRunIds: ['uncertain-short'],
        targetRunIds: ['uncertain-short'],
      },
    };

    await expect(resumed.runNow(automation.id, acknowledgement)).rejects.toThrow(
      'claim write failed',
    );
    expect(repo.findOpenRun(automation.id)).toMatchObject({
      source: 'manual',
      phase: 'queued',
      acknowledgedRunIds: ['uncertain-short'],
      acknowledgedSnapshotRunIds: ['uncertain-short'],
    });

    await resumed.runNow(automation.id, acknowledgement);
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).toHaveBeenCalledTimes(1);
    expect(
      repo.listRuns(automation.id).filter((item) => item.source === 'manual'),
    ).toHaveLength(1);
    expect(service.get(automation.id).status).toBe('completed');
  });

  it('rejects a second acknowledged retry while the first manual retry is still owned', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const blocker = dueAutomation();
    const automation = dueAutomation({ mode: 'short' });
    repo.appendRun(
      run(automation, {
        id: 'uncertain-short',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.save({
      ...service.get(automation.id),
      status: 'failed',
      nextRunAt: null,
      failure:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      progress:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });

    let releaseBlocker!: () => void;
    const resumed = scheduler(
      {
        run: vi.fn(async (_spec, ctx) => {
          if (ctx.automationId === blocker.id) {
            return new Promise<CheckResult>((resolve) => {
              releaseBlocker = () => resolve(okResult);
            });
          }
          return { ...okResult, occurrenceKey: 'run-2' };
        }),
      },
      {
        run: vi.fn(async () => ({
          detail: 'Report generated',
          sessionId: 'm1',
          subagentId: null,
          report: 'ready',
        })),
      },
      { maxConcurrentChecks: 1 },
    );
    const acknowledgement = {
      acknowledgement: {
        snapshotRunIds: ['uncertain-short'],
        targetRunIds: ['uncertain-short'],
      },
    };

    const blockingTick = resumed.tick();
    await Promise.resolve();
    const firstRetry = resumed.runNow(automation.id, acknowledgement);
    await Promise.resolve();

    await expect(
      resumed.runNow(automation.id, acknowledgement),
    ).rejects.toThrow(/retry already in progress/i);

    releaseBlocker();
    await firstRetry;
    await blockingTick;
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);
  });

  it('rejects acknowledgement takeover of an unowned manual run that was queued without one', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation({ mode: 'short' });
    repo.appendRun(
      run(automation, {
        id: 'uncertain-short',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.save({
      ...service.get(automation.id),
      status: 'failed',
      nextRunAt: null,
      failure:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      progress:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });
    repo.appendRun({
      id: 'manual-no-ack',
      automationId: automation.id,
      source: 'manual',
      phase: 'queued',
      scheduledForAt: null,
      occurrenceKey: null,
      dedupeKey: `manual:${automation.id}:manual-no-ack`,
      startedAt: '2026-01-01T00:00:02.000Z',
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to run now',
      sessionId: null,
      acknowledgedRunIds: null,
      acknowledgedSnapshotRunIds: null,
      resolvedByRunId: null,
    });

    await expect(
      scheduler(
        { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
        {
          run: vi.fn(async () => ({
            detail: 'should not run',
            sessionId: null,
            subagentId: null,
            report: null,
          })),
        },
      ).runNow(automation.id, {
        acknowledgement: {
          snapshotRunIds: ['uncertain-short'],
          targetRunIds: ['uncertain-short'],
        },
      }),
    ).rejects.toThrow(/retry already in progress/i);
  });

  it('rejects acknowledgement takeover when a recovered manual retry is missing its saved snapshot', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation({ mode: 'short' });
    repo.appendRun(
      run(automation, {
        id: 'uncertain-short',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.save({
      ...service.get(automation.id),
      status: 'failed',
      nextRunAt: null,
      failure:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      progress:
        'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
    });
    repo.appendRun({
      id: 'manual-missing-snapshot',
      automationId: automation.id,
      source: 'manual',
      phase: 'queued',
      scheduledForAt: null,
      occurrenceKey: null,
      dedupeKey: `manual:${automation.id}:manual-missing-snapshot`,
      startedAt: '2026-01-01T00:00:02.000Z',
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: 'Queued to run now',
      sessionId: null,
      acknowledgedRunIds: ['uncertain-short'],
      acknowledgedSnapshotRunIds: null,
      resolvedByRunId: null,
    });

    await expect(
      scheduler(
        { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
        {
          run: vi.fn(async () => ({
            detail: 'should not run',
            sessionId: null,
            subagentId: null,
            report: null,
          })),
        },
      ).runNow(automation.id, {
        acknowledgement: {
          snapshotRunIds: ['uncertain-short'],
          targetRunIds: ['uncertain-short'],
        },
      }),
    ).rejects.toThrow(/retry already in progress/i);
  });

  it('rejects stale acknowledgements and only resolves the intended uncertain runs', async () => {
    const { repo, service, scheduler, dueAutomation, run, advance } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'uncertain-a',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-1',
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.appendRun(
      run(automation, {
        id: 'uncertain-b',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-2',
        startedAt: '2026-01-01T00:00:02.000Z',
        endedAt: '2026-01-01T00:00:03.000Z',
        detail:
          'Previous action may have already run for occurrence "run-2". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );

    const actionsRun = vi.fn(async () => ({
      detail: 'Report generated',
      sessionId: 'm1',
      subagentId: null,
      report: 'ready',
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-1' })) },
      { run: actionsRun },
    );

    await expect(
      resumed.runNow(automation.id, {
        acknowledgement: {
          snapshotRunIds: ['uncertain-a'],
          targetRunIds: ['uncertain-a'],
        },
      }),
    ).rejects.toThrow(/stale or incomplete/i);

    await resumed.runNow(automation.id, {
      acknowledgement: {
        snapshotRunIds: ['uncertain-a', 'uncertain-b'],
        targetRunIds: ['uncertain-a'],
      },
    });
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).toHaveBeenCalledTimes(1);
    expect(repo.getRun('uncertain-a')).toMatchObject({
      resolvedByRunId: expect.any(String),
    });
    expect(repo.getRun('uncertain-b')?.resolvedByRunId).toBeNull();
    expect(service.get(automation.id).uncertainty?.unresolvedRunIds).toEqual([
      'uncertain-b',
    ]);

    const blockedReplay = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-2' })) },
      {
        run: vi.fn(async () => ({
          detail: 'should not rerun automatically',
          sessionId: null,
          subagentId: null,
          report: null,
        })),
      },
    );
    advance(60_000);
    await blockedReplay.tick();
    await expect(blockedReplay.waitForIdle(100)).resolves.toBe(true);

    expect(service.get(automation.id).uncertainty?.unresolvedRunIds).toEqual([
      'uncertain-b',
    ]);
  });

  it('does not let a retry acknowledgement authorize a run whose occurrence cannot be re-identified', async () => {
    const { repo, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'uncertain-known',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-1',
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );

    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: null })) },
      { run: actionsRun },
    );

    await resumed.runNow(automation.id, {
      acknowledgement: {
        snapshotRunIds: ['uncertain-known'],
        targetRunIds: ['uncertain-known'],
      },
    });
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).not.toHaveBeenCalled();
    expect(repo.getRun('uncertain-known')?.resolvedByRunId).toBeNull();
    expect(repo.listRuns(automation.id)).toContainEqual(
      expect.objectContaining({
        phase: 'finished',
        occurrenceKey: null,
        detail:
          'Automatic action replay is blocked for occurrence "run-1" because a previous attempt may already have run. Use Run now only if you intend to retry it.',
      }),
    );
  });

  it('keeps manual retries blocked while any unacknowledged unknown uncertainty remains', async () => {
    const { repo, service, scheduler, dueAutomation, run } = createHarness();
    const automation = dueAutomation();
    repo.appendRun(
      run(automation, {
        id: 'uncertain-unknown',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: null,
        endedAt: '2026-01-01T00:00:01.000Z',
        detail:
          'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );
    repo.appendRun(
      run(automation, {
        id: 'uncertain-known',
        phase: 'uncertain',
        triggered: true,
        status: 'failed',
        occurrenceKey: 'run-1',
        startedAt: '2026-01-01T00:00:02.000Z',
        endedAt: '2026-01-01T00:00:03.000Z',
        detail:
          'Previous action may have already run for occurrence "run-1". Automatic retries are blocked until you explicitly choose Run now.',
      }),
    );

    const actionsRun = vi.fn(async () => ({
      detail: 'should not run',
      sessionId: null,
      subagentId: null,
      report: null,
    }));
    const resumed = scheduler(
      { run: vi.fn(async () => ({ ...okResult, occurrenceKey: 'run-1' })) },
      { run: actionsRun },
    );

    await resumed.runNow(automation.id, {
      acknowledgement: {
        snapshotRunIds: ['uncertain-known', 'uncertain-unknown'],
        targetRunIds: ['uncertain-known'],
      },
    });
    await expect(resumed.waitForIdle(100)).resolves.toBe(true);

    expect(actionsRun).not.toHaveBeenCalled();
    expect(repo.getRun('uncertain-known')?.resolvedByRunId).toBeNull();
    expect(service.get(automation.id).uncertainty?.unresolvedRunIds).toEqual(
      expect.arrayContaining(['uncertain-known', 'uncertain-unknown']),
    );
  });

  it('rejects acknowledgements once the uncertainty has already been resolved', async () => {
    const { scheduler, dueAutomation } = createHarness();
    const automation = dueAutomation({ mode: 'short' });
    const resumed = scheduler(
      { run: vi.fn(async () => okResult) },
      {
        run: vi.fn(async () => ({
          detail: 'Report generated',
          sessionId: 'm1',
          subagentId: null,
          report: 'ready',
        })),
      },
    );

    await expect(
      resumed.runNow(automation.id, {
        acknowledgement: {
          snapshotRunIds: ['stale-run'],
          targetRunIds: ['stale-run'],
        },
      }),
    ).rejects.toThrow(/no longer pending/i);
  });
});
