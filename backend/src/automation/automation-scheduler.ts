import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type {
  Automation,
  AutomationRepo,
  CheckResult,
  CheckRunner,
  ActionRunner,
} from './automation-contract.js';
import { evaluateCondition, shouldFire } from './condition.js';
import { detectAuthFromError, detectAuthFromResult } from './auth-detection.js';
import type { AutomationService } from './automation-service.js';

export interface AutomationSchedulerDeps {
  service: AutomationService;
  repo: AutomationRepo;
  checks: CheckRunner;
  actions: ActionRunner;
  clock: Clock;
  ids: IdGenerator;
  config: { minIntervalMs: number; maxConcurrentChecks: number };
}

export interface AutomationScheduler {
  /** Processes every automation whose next run is due. */
  tick(): Promise<void>;
  /** Reschedules persisted active automations so they resume after restart. */
  resume(): void;
  /** Begins the background tick loop. */
  start(): void;
  /** Stops the background tick loop. */
  stop(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Automation step failed';
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const size = Math.min(limit, queue.length);
  const workers = Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await worker(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Background engine for **Monitors & Automations**. On each {@link tick} it runs
 * every due monitor's check, evaluates its condition, and — when the condition
 * fires (edge-triggered for long monitors) — runs its action. Short monitors
 * complete after the first trigger; long monitors reschedule until cancelled or
 * their `maxRuns` cap is hit. Concurrency is bounded by config so many monitors
 * cannot hammer external APIs at once.
 */
export function createAutomationScheduler(
  deps: AutomationSchedulerDeps,
): AutomationScheduler {
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const rescheduleAt = (automation: Automation): string =>
    new Date(deps.clock.now().getTime() + automation.intervalMs).toISOString();

  /**
   * Persists a computed result state **only if the monitor is still active**.
   * A check/action can take time; if the user paused, cancelled, or deleted the
   * monitor from the Automations panel while it was in flight, writing back the
   * stale snapshot would resurrect it and make those controls a no-op. Re-reading
   * the live record and bailing keeps the user's action authoritative.
   */
  const persistIfActive = (next: Automation): void => {
    const current = deps.repo.get(next.id);
    if (current !== null && current.status === 'active') {
      deps.service.save(next);
    }
  };

  const recordRun = (
    automation: Automation,
    startedAt: string,
    fields: {
      triggered: boolean;
      status: 'ok' | 'failed' | 'skipped';
      detail: string | null;
      sessionId: string | null;
    },
  ): void => {
    deps.repo.appendRun({
      id: deps.ids.next(),
      automationId: automation.id,
      startedAt,
      endedAt: deps.clock.isoNow(),
      ...fields,
    });
  };

  /**
   * Parks a monitor in `needs-auth` (stops polling) with a clear login prompt
   * when a check hits an authentication wall, so the user can sign in and resume
   * instead of the monitor failing silently on every tick.
   */
  const enterNeedsAuth = (
    automation: Automation,
    startedAt: string,
    message: string,
  ): void => {
    recordRun(automation, startedAt, {
      triggered: false,
      status: 'failed',
      detail: `Sign-in required: ${message}`,
      sessionId: null,
    });
    persistIfActive({
      ...automation,
      status: 'needs-auth',
      lastCheckedAt: startedAt,
      nextRunAt: null,
      failure: message,
      progress: 'Sign-in required',
    });
  };

  const fireAction = async (
    automation: Automation,
    startedAt: string,
    checkResult: CheckResult,
  ): Promise<void> => {
    let action;
    try {
      action = await deps.actions.run(automation.action, {
        automationId: automation.id,
        origin: automation.origin,
      });
    } catch (error) {
      const message = errorMessage(error);
      recordRun(automation, startedAt, {
        triggered: true,
        status: 'failed',
        detail: `Action failed: ${message}`,
        sessionId: null,
      });
      persistIfActive({
        ...automation,
        status: 'failed',
        lastCheckedAt: startedAt,
        nextRunAt: null,
        failure: message,
        progress: `Action failed: ${message}`,
      });
      return;
    }

    const runCount = automation.runCount + 1;
    recordRun(automation, startedAt, {
      triggered: true,
      status: 'ok',
      detail: action.detail,
      sessionId: action.sessionId,
    });
    const reachedMax =
      automation.maxRuns !== null && runCount >= automation.maxRuns;
    const completed = automation.mode === 'short' || reachedMax;
    persistIfActive({
      ...automation,
      runCount,
      lastOccurrenceKey: checkResult.occurrenceKey,
      lastCheckedAt: startedAt,
      status: completed ? 'completed' : 'active',
      nextRunAt: completed ? null : rescheduleAt(automation),
      progress: action.detail,
    });
  };

  const runOnce = async (automation: Automation): Promise<void> => {
    inFlight.add(automation.id);
    const startedAt = deps.clock.isoNow();
    try {
      let checkResult: CheckResult;
      try {
        checkResult = await deps.checks.run(automation.check, {
          automationId: automation.id,
          origin: automation.origin,
        });
      } catch (error) {
        const authMessage = detectAuthFromError(error);
        if (authMessage !== null) {
          enterNeedsAuth(automation, startedAt, authMessage);
          return;
        }
        const message = errorMessage(error);
        recordRun(automation, startedAt, {
          triggered: false,
          status: 'failed',
          detail: `Check failed: ${message}`,
          sessionId: null,
        });
        persistIfActive({
          ...automation,
          lastCheckedAt: startedAt,
          nextRunAt: rescheduleAt(automation),
          progress: `Check failed: ${message}`,
        });
        return;
      }

      const authMessage = detectAuthFromResult(checkResult);
      if (authMessage !== null) {
        enterNeedsAuth(automation, startedAt, authMessage);
        return;
      }

      const matched = evaluateCondition(automation.condition, checkResult);
      const fire = shouldFire({
        matched,
        mode: automation.mode,
        occurrenceKey: checkResult.occurrenceKey,
        lastOccurrenceKey: automation.lastOccurrenceKey,
      });

      if (!fire) {
        recordRun(automation, startedAt, {
          triggered: false,
          status: 'ok',
          detail: `Checked: ${checkResult.status ?? checkResult.text}`,
          sessionId: null,
        });
        persistIfActive({
          ...automation,
          lastCheckedAt: startedAt,
          nextRunAt: rescheduleAt(automation),
          progress: `Waiting · ${checkResult.status ?? checkResult.text}`,
        });
        return;
      }

      await fireAction(automation, startedAt, checkResult);
    } finally {
      inFlight.delete(automation.id);
    }
  };

  const isDue = (automation: Automation, now: number): boolean =>
    automation.status === 'active' &&
    automation.nextRunAt !== null &&
    Date.parse(automation.nextRunAt) <= now &&
    !inFlight.has(automation.id);

  return {
    async tick() {
      const now = deps.clock.now().getTime();
      const due = deps.service.list().filter((a) => isDue(a, now));
      await runPool(due, deps.config.maxConcurrentChecks, runOnce);
    },
    resume() {
      const now = deps.clock.isoNow();
      for (const automation of deps.service.list()) {
        if (automation.status === 'active' && automation.nextRunAt === null) {
          deps.service.save({ ...automation, nextRunAt: now });
        }
      }
    },
    start() {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => {
        void this.tick();
      }, deps.config.minIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
