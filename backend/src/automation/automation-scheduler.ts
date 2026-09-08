import type { EventBus } from '../kernel/event-bus.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import { ConflictError, NotFoundError } from '../kernel/error-types.js';
import type {
  ActionResult,
  ActionRunner,
  Automation,
  AutomationUncertainty,
  AutomationRepo,
  AutomationRun,
  CheckResult,
  CheckRunner,
  UncertaintyAcknowledgement,
} from './automation-contract.js';
import {
  decorateAutomationWithUncertainty,
  summarizeAutomationUncertainty,
} from './automation-uncertainty.js';
import { detectAuthFromError, detectAuthFromResult } from './auth-detection.js';
import { evaluateCondition, shouldFire } from './condition.js';
import type { AutomationEventMap } from './automation-service.js';

export interface AutomationSchedulerDeps {
  repo: AutomationRepo;
  checks: CheckRunner;
  actions: ActionRunner;
  clock: Clock;
  ids: IdGenerator;
  bus: EventBus<AutomationEventMap>;
  config: { minIntervalMs: number; maxConcurrentChecks: number };
  onError?: (error: unknown) => void;
}

export interface AutomationScheduler {
  /** Processes every automation whose next run is due. */
  tick(): Promise<void>;
  /** Wakes a single due automation without waiting for the next interval tick. */
  kick(id: string): Promise<void>;
  /** Queues an explicit manual retry/run without invalidating existing admissions. */
  runNow(id: string, options?: AutomationRunNowOptions): Promise<Automation>;
  /** Aborts a currently running check/action, or drops a queued occurrence. */
  abort(id: string): void;
  /** Aborts every currently running check/action. */
  abortAll(): void;
  /** Reschedules persisted active automations so they resume after restart. */
  resume(): void;
  /** Begins the background tick loop. */
  start(): void;
  /** Stops the background tick loop. */
  stop(): void;
  /** Permanently stops new admissions and aborts every in-flight run. */
  shutdown(): void;
  /** Resolves once every in-flight check/action has settled, or false on timeout. */
  waitForIdle(timeoutMs: number, automationId?: string): Promise<boolean>;
}

export interface ManagedAutomationScheduler extends AutomationScheduler {
  /** Blocks future admissions for this identity, aborts, then confirms settlement. */
  quiesce(id: string, timeoutMs: number): Promise<boolean>;
}

export interface AutomationRunNowOptions {
  acknowledgement?: UncertaintyAcknowledgement | null;
}

type AdmissionSource = AutomationRun['source'];
type OpenRunPhase = Extract<AutomationRun['phase'], 'queued' | 'checking' | 'acting'>;
type LiveAdmissionState = 'queued' | 'running' | 'released';

interface Admission {
  automationId: string;
  runId: string;
  source: AdmissionSource;
  state: LiveAdmissionState;
  error: unknown | null;
  dispatched: Promise<void>;
  settled: Promise<void>;
  markDispatched(): void;
  release(): void;
}

const OPEN_PHASES: ReadonlySet<OpenRunPhase> = new Set([
  'queued',
  'checking',
  'acting',
]);

const TERMINAL_STATUSES: ReadonlySet<Automation['status']> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

type UncertainBlock =
  | { runId: string; type: 'unknown'; detail: string }
  | { runId: string; type: 'known'; occurrenceKey: string; detail: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Automation step failed';
}

function queuedDetail(source: AdmissionSource): string {
  return source === 'manual' ? 'Queued to run now' : 'Queued to check';
}

function cancelledDetail(run: AutomationRun): string {
  return run.phase === 'queued'
    ? 'Run cancelled before dispatch'
    : 'Run cancelled before completion';
}

function activeRunSummary(checkResult: CheckResult): string {
  return `Checked: ${checkResult.status ?? checkResult.text}`;
}

function interruptedDetail(_run: AutomationRun): string {
  return 'Previous backend stopped before the check completed';
}

function uncertainDetail(run: AutomationRun): string {
  return run.occurrenceKey === null
    ? 'Previous action may have run, but its occurrence identity is unknown. Automatic retries are blocked until you explicitly choose Run now.'
    : `Previous action may have already run for occurrence "${run.occurrenceKey}". Automatic retries are blocked until you explicitly choose Run now.`;
}

function blockedAttemptDetail(block: UncertainBlock): string {
  return block.type === 'unknown'
    ? 'Automatic action replay is blocked because a previous action may already have run and its occurrence identity is unknown. Use Run now only if you intend to retry it.'
    : `Automatic action replay is blocked for occurrence "${block.occurrenceKey}" because a previous attempt may already have run. Use Run now only if you intend to retry it.`;
}

function isOpenPhase(phase: AutomationRun['phase']): phase is OpenRunPhase {
  return OPEN_PHASES.has(phase as OpenRunPhase);
}

function isActiveDue(automation: Automation, now: number): boolean {
  return (
    automation.status === 'active' &&
    automation.nextRunAt !== null &&
    Date.parse(automation.nextRunAt) <= now
  );
}

function isStillActive(automation: Automation | null): automation is Automation {
  return automation !== null && automation.status === 'active';
}

function shouldBlockAutomaticDispatch(
  blocks: readonly UncertainBlock[],
  source: AdmissionSource,
  occurrenceKey: string | null,
): boolean {
  if (source === 'manual' || blocks.length === 0) {
    return false;
  }
  if (blocks.some((block) => block.type === 'unknown')) {
    return true;
  }
  return (
    occurrenceKey === null ||
    blocks.some(
      (block) => block.type === 'known' && block.occurrenceKey === occurrenceKey,
    )
  );
}

function shouldBlockManualDispatch(
  remainingBlocks: readonly UncertainBlock[],
  occurrenceKey: string | null,
): boolean {
  if (remainingBlocks.some((block) => block.type === 'unknown')) {
    return true;
  }
  if (occurrenceKey === null) {
    return remainingBlocks.length > 0;
  }
  return remainingBlocks.some(
    (block) => block.type === 'known' && block.occurrenceKey === occurrenceKey,
  );
}

export function describeWaitingProgress(
  automation: Automation,
  checkResult: CheckResult,
): string {
  const condition =
    automation.condition.type === 'status-equals'
      ? `status "${automation.condition.value}"`
      : automation.condition.type === 'conclusion-equals'
        ? `conclusion "${automation.condition.value}"`
        : automation.condition.type === 'exit-code'
          ? `exit code ${automation.condition.equals}`
          : automation.condition.type === 'text-contains'
            ? `text containing "${automation.condition.value}"`
            : automation.condition.type === 'ai-verdict'
              ? 'an affirmative AI verdict'
              : 'the condition';
  const signal =
    automation.check.type === 'shell' &&
    checkResult.status !== null &&
    /^-?\d+$/.test(checkResult.status)
      ? `exit ${checkResult.status}`
      : (checkResult.status ?? checkResult.text);
  return `Waiting for ${condition} · last result: ${signal}`;
}

/**
 * Background engine for **Monitors & Automations**. It persists a single shared
 * admission queue across ticks and manual "Run now" requests, so the configured
 * concurrency cap applies globally. Every occurrence is written before dispatch,
 * revalidated immediately before execution, and finished exactly once.
 */
export function createAutomationScheduler(
  deps: AutomationSchedulerDeps,
): ManagedAutomationScheduler {
  const queue: Admission[] = [];
  const admissions = new Map<string, Admission>();
  const controllers = new Map<string, AbortController>();
  const idleWaiters = new Set<() => void>();
  const blockedAutomations = new Set<string>();
  let ownedRuns = 0;
  let activeWorkers = 0;
  let admissionsClosed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const rescheduleAt = (automation: Automation): string =>
    new Date(deps.clock.now().getTime() + automation.intervalMs).toISOString();

  const stampAutomation = (automation: Automation): Automation => ({
    ...automation,
    updatedAt: deps.clock.isoNow(),
  });

  const notifyIdleIfNeeded = (): void => {
    for (const waiter of [...idleWaiters]) waiter();
  };

  const decorateAutomation = (automation: Automation): Automation =>
    decorateAutomationWithUncertainty(
      automation,
      deps.repo.listPendingUncertainRuns(automation.id),
    );

  const emitAutomation = (automation: Automation | null): void => {
    if (automation !== null) {
      deps.bus.emit('automation.updated', decorateAutomation(automation));
    }
  };

  const createAdmission = (run: AutomationRun): Admission => {
    ownedRuns += 1;
    let resolveDispatched: (() => void) | null = null;
    let resolveSettled: (() => void) | null = null;
    const dispatched = new Promise<void>((resolve) => {
      resolveDispatched = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const admission: Admission = {
      automationId: run.automationId,
      runId: run.id,
      source: run.source,
      state: 'queued',
      error: null,
      dispatched,
      settled,
      markDispatched() {
        resolveDispatched?.();
        resolveDispatched = null;
      },
      release() {
        releaseOwned();
      },
    };
    let releaseOwned!: () => void;
    releaseOwned = () => {
      releaseOwned = admission.markDispatched;
      admission.state = 'released';
      const index = queue.indexOf(admission);
      if (index >= 0) {
        queue.splice(index, 1);
      }
      if (admissions.get(admission.automationId) === admission) {
        admissions.delete(admission.automationId);
      }
      ownedRuns = Math.max(0, ownedRuns - 1);
      admission.markDispatched();
      resolveSettled?.();
      resolveSettled = null;
      notifyIdleIfNeeded();
    };
    admissions.set(run.automationId, admission);
    return admission;
  };

  const createRun = (
    automation: Automation,
    source: AdmissionSource,
    acknowledgement?: UncertaintyAcknowledgement | null,
  ): AutomationRun => {
    const startedAt = deps.clock.isoNow();
    const id = deps.ids.next();
    return {
      id,
      automationId: automation.id,
      source,
      phase: 'queued',
      scheduledForAt: source === 'scheduled' ? automation.nextRunAt : null,
      occurrenceKey: null,
      dedupeKey:
        source === 'scheduled'
          ? `scheduled:${automation.id}:${automation.nextRunAt}`
          : `manual:${automation.id}:${startedAt}:${id}`,
      startedAt,
      dispatchedAt: null,
      endedAt: null,
      triggered: false,
      status: 'skipped',
      detail: queuedDetail(source),
      sessionId: null,
      acknowledgedRunIds: acknowledgement?.targetRunIds ?? null,
      acknowledgedSnapshotRunIds: acknowledgement?.snapshotRunIds ?? null,
      resolvedByRunId: null,
    };
  };

  const runPersist = <T>(
    work: () => { result: T; automation?: Automation | null },
  ): T => {
    let automationToEmit: Automation | null = null;
    const result = deps.repo.transact(() => {
      const outcome = work();
      automationToEmit = outcome.automation ?? null;
      if (automationToEmit !== null) {
        deps.repo.save(automationToEmit);
      }
      return outcome.result;
    });
    emitAutomation(automationToEmit);
    return result;
  };

  const queueRecoveredRun = (run: AutomationRun): Admission | null => {
    if (admissionsClosed || blockedAutomations.has(run.automationId) ||
      admissions.has(run.automationId) || !isOpenPhase(run.phase)) {
      return null;
    }
    const admission = createAdmission(run);
    queue.push(admission);
    return admission;
  };

  const pendingUncertaintyBlocks = (automationId: string): UncertainBlock[] =>
    deps.repo.listPendingUncertainRuns(automationId).map((run) =>
      run.occurrenceKey === null
        ? {
            runId: run.id,
            type: 'unknown' as const,
            detail: run.detail ?? uncertainDetail(run),
          }
        : {
            runId: run.id,
            type: 'known' as const,
            occurrenceKey: run.occurrenceKey,
            detail: run.detail ?? uncertainDetail(run),
          },
    );

  const pickBlockingAttempt = (
    blocks: readonly UncertainBlock[],
    occurrenceKey: string | null,
  ): UncertainBlock | null => {
    const unknown = blocks.find((block) => block.type === 'unknown');
    if (unknown) {
      return unknown;
    }
    if (occurrenceKey === null) {
      return blocks[0]!;
    }
    return (
      blocks.find(
        (block) => block.type === 'known' && block.occurrenceKey === occurrenceKey,
      ) ?? null
    );
  };

  const uncertaintySnapshotIds = (blocks: readonly UncertainBlock[]): string[] =>
    blocks.map((block) => block.runId).sort();

  const sameIdSet = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);

  const acknowledgedTargets = (
    run: AutomationRun,
    blocks: readonly UncertainBlock[],
    occurrenceKey: string | null,
  ): UncertainBlock[] => {
    const snapshot = run.acknowledgedSnapshotRunIds ?? [];
    const targets = run.acknowledgedRunIds ?? [];
    const current = uncertaintySnapshotIds(blocks);
    if (
      snapshot.length === 0 ||
      targets.length === 0 ||
      !sameIdSet(snapshot, current) ||
      !targets.every((id) => current.includes(id))
    ) {
      return [];
    }
    const matched = blocks.filter((block) => targets.includes(block.runId));
    if (matched.some((block) => block.type === 'unknown')) {
      return matched;
    }
    if (occurrenceKey === null) {
      return [];
    }
    return matched.filter(
      (block) => block.type === 'known' && block.occurrenceKey === occurrenceKey,
    );
  };

  const reserveRun = (
    automationId: string,
    source: AdmissionSource,
  ): Admission | null => {
    if (admissionsClosed || blockedAutomations.has(automationId)) {
      return null;
    }
    if (admissions.has(automationId)) {
      return null;
    }
    const result = runPersist(() => {
      const automation = deps.repo.get(automationId);
      if (automation === null || !isActiveDue(automation, deps.clock.now().getTime())) {
        return { result: null };
      }
      const existing = deps.repo.findOpenRun(automationId);
      if (existing !== null) {
        return { result: existing };
      }
      const run = createRun(automation, source);
      deps.repo.appendRun(run);
      const nextAutomation = stampAutomation({
        ...automation,
        progress: run.detail,
      });
      return { result: run, automation: nextAutomation };
    });
    if (result === null) {
      return null;
    }
    if (result.phase !== 'queued') {
      return null;
    }
    const admission = createAdmission(result);
    queue.push(admission);
    return admission;
  };

  const revalidateQueuedRun = (run: AutomationRun, automation: Automation | null): boolean => {
    if (automation === null || automation.status !== 'active') {
      return false;
    }
    if (run.source === 'manual') {
      return true;
    }
    return (
      run.scheduledForAt !== null &&
      automation.nextRunAt === run.scheduledForAt &&
      Date.parse(run.scheduledForAt) <= deps.clock.now().getTime()
    );
  };

  const markQueuedCancelled = (admission: Admission): void => {
    runPersist(() => {
      const run = deps.repo.getRun(admission.runId);
      if (run === null || run.phase !== 'queued') {
        return { result: undefined };
      }
      deps.repo.saveRun({
        ...run,
        phase: 'cancelled',
        endedAt: deps.clock.isoNow(),
        detail: cancelledDetail(run),
      });
      return { result: undefined };
    });
    admission.release();
  };

  const settleAbortedRun = (
    runId: string,
    message?: string,
  ): void => {
    runPersist(() => {
      const currentRun = deps.repo.getRun(runId);
      if (currentRun === null || !isOpenPhase(currentRun.phase)) {
        return { result: undefined };
      }
      const automation = deps.repo.get(currentRun.automationId);
      const afterDispatch = currentRun.phase === 'acting';
      const detail = message ?? (afterDispatch ? uncertainDetail(currentRun) : cancelledDetail(currentRun));
      const phase: AutomationRun['phase'] = afterDispatch ? 'uncertain' : 'cancelled';
      deps.repo.saveRun({
        ...currentRun,
        phase,
        endedAt: deps.clock.isoNow(),
        detail,
        status: afterDispatch || currentRun.triggered ? 'failed' : 'skipped',
      });
      if (automation === null) {
        return { result: undefined };
      }
      if (automation.status === 'active') {
        if (afterDispatch && automation.mode === 'short') {
          return {
            result: undefined,
            automation: stampAutomation({
              ...automation,
              status: 'failed',
              nextRunAt: null,
              failure: detail,
              progress: detail,
            }),
          };
        }
        return {
          result: undefined,
          automation: stampAutomation({
            ...automation,
            nextRunAt:
              currentRun.source === 'scheduled' && automation.mode === 'long'
                ? rescheduleAt(automation)
                : automation.nextRunAt,
            progress: detail,
          }),
        };
      }
      return {
        result: undefined,
        automation: stampAutomation({
          ...automation,
          progress: detail,
        }),
      };
    });
  };

  const markRecoveredRun = (run: AutomationRun): void => {
    runPersist(() => {
      const currentRun = deps.repo.getRun(run.id);
      if (currentRun === null || !isOpenPhase(currentRun.phase)) {
        return { result: undefined };
      }
      const automation = deps.repo.get(currentRun.automationId);
      const afterDispatch = currentRun.phase === 'acting';
      const detail = afterDispatch
        ? uncertainDetail(currentRun)
        : interruptedDetail(currentRun);
      const phase: AutomationRun['phase'] = afterDispatch
        ? 'uncertain'
        : 'interrupted';
      deps.repo.saveRun({
        ...currentRun,
        phase,
        endedAt: deps.clock.isoNow(),
        detail,
        status: afterDispatch || currentRun.triggered ? 'failed' : 'skipped',
      });
      if (automation === null) {
        return { result: undefined };
      }
      if (automation.status === 'active') {
        if (afterDispatch && automation.mode === 'short') {
          return {
            result: undefined,
            automation: stampAutomation({
              ...automation,
              status: 'failed',
              nextRunAt: null,
              failure: detail,
              progress: detail,
            }),
          };
        }
        return {
          result: undefined,
          automation: stampAutomation({
            ...automation,
            nextRunAt: rescheduleAt(automation),
            progress: detail,
          }),
        };
      }
      return {
        result: undefined,
        automation: stampAutomation({
          ...automation,
          progress: detail,
        }),
      };
    });
  };

  const beginDispatch = (
    admission: Admission,
  ): { automation: Automation; run: AutomationRun } | null =>
    runPersist(() => {
      const run = deps.repo.getRun(admission.runId);
      if (run === null || run.phase !== 'queued') {
        return { result: null };
      }
      const automation = deps.repo.get(admission.automationId);
      if (!revalidateQueuedRun(run, automation) || automation === null) {
        deps.repo.saveRun({
          ...run,
          phase: 'cancelled',
          endedAt: deps.clock.isoNow(),
          detail: cancelledDetail(run),
        });
        return { result: null };
      }
      const nextRun: AutomationRun = {
        ...run,
        phase: 'checking',
        dispatchedAt: deps.clock.isoNow(),
        detail: 'Checking now',
      };
      deps.repo.saveRun(nextRun);
      const nextAutomation = stampAutomation({
        ...automation,
        progress: 'Checking now',
      });
      return {
        result: { automation: nextAutomation, run: nextRun },
        automation: nextAutomation,
      };
    });

  const activateAutomation = (automation: Automation): Automation =>
    automation.status === 'active' && automation.failure === null
      ? automation
      : stampAutomation({
          ...automation,
          status: 'active',
          failure: null,
        });

  const canRetryFailedUncertainShort = (
    automation: Automation,
    uncertainty: AutomationUncertainty | null,
  ): boolean =>
    automation.mode === 'short' &&
    automation.status === 'failed' &&
    uncertainty !== null;

  const requireRetryAuthorisation = (
    automation: Automation,
    acknowledgement: UncertaintyAcknowledgement | null | undefined,
  ): UncertaintyAcknowledgement | null => {
    const uncertainty = summarizeAutomationUncertainty(
      deps.repo.listPendingUncertainRuns(automation.id),
    );
    const terminalFinished =
      TERMINAL_STATUSES.has(automation.status) &&
      !canRetryFailedUncertainShort(automation, uncertainty);
    if (terminalFinished) {
      throw new ConflictError(`Automation is already finished: ${automation.id}`);
    }
    if (uncertainty === null) {
      if (acknowledgement) {
        throw new ConflictError(
          'The acknowledged uncertainty is no longer pending. Refresh and try again.',
        );
      }
      return null;
    }
    if (acknowledgement == null) {
      throw new ConflictError(uncertainty.summary);
    }
    const snapshot = [...new Set(acknowledgement.snapshotRunIds)].sort();
    const targets = [...new Set(acknowledgement.targetRunIds)].sort();
    const current = [...uncertainty.unresolvedRunIds].sort();
    if (
      snapshot.length === 0 ||
      targets.length === 0 ||
      !sameIdSet(snapshot, current) ||
      !targets.every((id) => current.includes(id))
    ) {
      throw new ConflictError(
        'The uncertainty acknowledgement is stale or incomplete. Refresh and confirm the retry again.',
      );
    }
    return {
      snapshotRunIds: snapshot,
      targetRunIds: targets,
    };
  };

  const queueManualRun = (
    automationId: string,
    acknowledgement?: UncertaintyAcknowledgement | null,
  ): {
    automation: Automation;
    run: AutomationRun | null;
    reuseExisting: boolean;
  } =>
    runPersist<{
      automation: Automation;
      run: AutomationRun | null;
      reuseExisting: boolean;
    }>(() => {
      const automation = deps.repo.get(automationId);
      if (automation === null) {
        throw new NotFoundError(`Automation not found: ${automationId}`);
      }
      const normalizedAcknowledgement = requireRetryAuthorisation(
        automation,
        acknowledgement,
      );
      const activeAutomation = activateAutomation(automation);
      const existing = deps.repo.findOpenRun(automationId);
      if (existing !== null) {
        if (
          normalizedAcknowledgement !== null &&
          !(
            existing.source === 'manual' &&
            existing.phase === 'queued' &&
            admissions.get(automationId) === undefined &&
            sameIdSet(
              existing.acknowledgedRunIds ?? [],
              normalizedAcknowledgement.targetRunIds,
            ) &&
            sameIdSet(
              existing.acknowledgedSnapshotRunIds ?? [],
              normalizedAcknowledgement.snapshotRunIds,
            )
          )
        ) {
          const conflictingOwner =
            existing.source === 'scheduled'
              ? existing.phase === 'queued'
                ? 'queued scheduled run'
                : 'running scheduled run'
              : 'retry already in progress';
          throw new ConflictError(
            `A ${conflictingOwner} already owns this monitor, so the retry acknowledgement could not be applied. Wait for it to finish or cancel it, then refresh and retry.`,
          );
        }
        const snapshot = {
          ...activeAutomation,
          progress: existing.detail ?? activeAutomation.progress,
        };
        return {
          result: {
            automation: snapshot,
            run:
              existing.phase === 'queued' &&
              admissions.get(automationId) === undefined
                ? existing
                : null,
            reuseExisting: true,
          },
          automation:
            activeAutomation === automation
              ? null
              : snapshot,
        };
      }
      const run = createRun(activeAutomation, 'manual', normalizedAcknowledgement);
      const queuedAutomation = stampAutomation({
        ...activeAutomation,
        progress: run.detail,
      });
      deps.repo.appendRun(run);
      return {
        result: {
          automation: queuedAutomation,
          run,
          reuseExisting: false,
        },
        automation: queuedAutomation,
      };
    });

  const finishRun = (
    runId: string,
    update: (
      run: AutomationRun,
      automation: Automation | null,
    ) => { run: AutomationRun; automation?: Automation | null },
  ): void => {
    runPersist(() => {
      const run = deps.repo.getRun(runId);
      if (run === null) {
        return { result: undefined };
      }
      const automation = deps.repo.get(run.automationId);
      const next = update(run, automation);
      deps.repo.saveRun(next.run);
      return { result: undefined, automation: next.automation ?? null };
    });
  };

  const reconcileUncertainRuns = (
    currentRun: AutomationRun,
    occurrenceKey: string | null,
  ): void => {
    const acknowledged = new Set(currentRun.acknowledgedRunIds ?? []);
    for (const run of deps.repo.listPendingUncertainRuns(currentRun.automationId)) {
      if (run.id === currentRun.id || run.resolvedByRunId != null) {
        continue;
      }
      const resolveUnknown = run.occurrenceKey === null && acknowledged.has(run.id);
      const resolveKnown =
        occurrenceKey !== null &&
        run.occurrenceKey === occurrenceKey &&
        (acknowledged.size === 0 || acknowledged.has(run.id));
      if (!resolveUnknown && !resolveKnown) {
        continue;
      }
      deps.repo.saveRun({
        ...run,
        resolvedByRunId: currentRun.id,
      });
    }
  };

  const persistCompletedCheck = (
    run: AutomationRun,
    checkResult: CheckResult,
    detail: string,
  ): void => {
    finishRun(run.id, (currentRun, automation) => ({
      run: {
        ...currentRun,
        phase: 'finished',
        endedAt: deps.clock.isoNow(),
        occurrenceKey: checkResult.occurrenceKey,
        detail,
        status: 'ok',
      },
      automation:
        isStillActive(automation)
          ? stampAutomation({
              ...automation,
              lastCheckedAt: currentRun.dispatchedAt ?? currentRun.startedAt,
              nextRunAt: rescheduleAt(automation),
              progress: describeWaitingProgress(automation, checkResult),
            })
          : null,
    }));
  };

  const persistCheckFailure = (
    run: AutomationRun,
    message: string,
  ): void => {
    finishRun(run.id, (currentRun, automation) => ({
      run: {
        ...currentRun,
        phase: 'finished',
        endedAt: deps.clock.isoNow(),
        detail: `Check failed: ${message}`,
        status: 'failed',
      },
      automation:
        isStillActive(automation)
          ? stampAutomation({
              ...automation,
              lastCheckedAt: currentRun.dispatchedAt ?? currentRun.startedAt,
              nextRunAt: rescheduleAt(automation),
              progress: `Check failed: ${message}`,
            })
          : null,
    }));
  };

  const enterNeedsAuth = (
    run: AutomationRun,
    message: string,
  ): void => {
    finishRun(run.id, (currentRun, automation) => ({
      run: {
        ...currentRun,
        phase: 'finished',
        endedAt: deps.clock.isoNow(),
        detail: `Sign-in required: ${message}`,
        status: 'failed',
      },
      automation:
        isStillActive(automation)
          ? stampAutomation({
              ...automation,
              status: 'needs-auth',
              lastCheckedAt: currentRun.dispatchedAt ?? currentRun.startedAt,
              nextRunAt: null,
              failure: message,
              progress: 'Sign-in required',
            })
          : null,
    }));
  };

  const beginAction = (
    run: AutomationRun,
    checkResult: CheckResult,
    detail: string,
  ): { automation: Automation; run: AutomationRun } | null =>
    runPersist(() => {
      const currentRun = deps.repo.getRun(run.id);
      if (currentRun === null || currentRun.phase !== 'checking') {
        return { result: null };
      }
      const automation = deps.repo.get(run.automationId);
      if (!isStillActive(automation)) {
        return { result: null };
      }
      const nextRun: AutomationRun = {
        ...currentRun,
        phase: 'acting',
        occurrenceKey: checkResult.occurrenceKey,
        triggered: true,
        detail,
      };
      deps.repo.saveRun(nextRun);
      const nextAutomation = stampAutomation({
        ...automation,
        progress: detail,
      });
      return {
        result: { automation: nextAutomation, run: nextRun },
        automation: nextAutomation,
      };
    });

  const persistActionSuccess = (
    runId: string,
    checkResult: CheckResult,
    action: ActionResult,
  ): void => {
    finishRun(runId, (currentRun, automation) => {
      reconcileUncertainRuns(currentRun, checkResult.occurrenceKey);
      const activeAutomation = isStillActive(automation) ? automation : null;
      const runCount = activeAutomation ? activeAutomation.runCount + 1 : 0;
      const reachedMax =
        activeAutomation?.maxRuns !== null &&
        activeAutomation !== null &&
        runCount >= activeAutomation.maxRuns;
      const completed =
        activeAutomation !== null &&
        (activeAutomation.mode === 'short' || reachedMax);
      return {
        run: {
          ...currentRun,
          phase: 'finished',
          occurrenceKey: checkResult.occurrenceKey,
          endedAt: deps.clock.isoNow(),
          detail: action.detail,
          sessionId: action.sessionId,
          report: action.report,
          status: 'ok',
          triggered: true,
        },
        automation:
          activeAutomation === null
            ? null
            : stampAutomation({
                ...activeAutomation,
                runCount,
                lastOccurrenceKey: checkResult.occurrenceKey,
                lastCheckedAt:
                  currentRun.dispatchedAt ?? currentRun.startedAt,
                status: completed ? 'completed' : 'active',
                nextRunAt: completed ? null : rescheduleAt(activeAutomation),
                progress: action.detail,
              }),
      };
    });
  };

  const persistActionFailure = (
    runId: string,
    message: string,
  ): void => {
    finishRun(runId, (currentRun, automation) => ({
      run: {
        ...currentRun,
        phase: 'finished',
        endedAt: deps.clock.isoNow(),
        detail: `Action failed: ${message}`,
        status: 'failed',
      },
      automation:
        isStillActive(automation)
          ? stampAutomation({
              ...automation,
              status: 'failed',
              lastCheckedAt: currentRun.dispatchedAt ?? currentRun.startedAt,
              nextRunAt: null,
              failure: message,
              progress: `Action failed: ${message}`,
            })
          : null,
    }));
  };

  const fireAction = async (
    automation: Automation,
    run: AutomationRun,
    checkResult: CheckResult,
    signal: AbortSignal,
  ): Promise<{ completion: Promise<void> } | null> => {
    let action: ActionResult;
    try {
      action = await deps.actions.run(automation.action, {
        automationId: automation.id,
        origin: automation.origin,
        signal,
      });
    } catch (error) {
      if (signal.aborted || deps.repo.get(automation.id) === null) {
        settleAbortedRun(run.id);
        return null;
      }
      persistActionFailure(run.id, errorMessage(error));
      return null;
    }
    if (signal.aborted || deps.repo.get(automation.id) === null) {
      settleAbortedRun(run.id);
      return null;
    }
    if (!action.completion) {
      persistActionSuccess(run.id, checkResult, action);
      return null;
    }
    if (!action.subagentId) {
      persistActionFailure(
        run.id,
        'Action completion is only supported for subagent actions',
      );
      return null;
    }
    return {
      completion: action.completion.then(
        () => {
          if (signal.aborted || deps.repo.get(automation.id) === null) {
            settleAbortedRun(run.id);
            return;
          }
          persistActionSuccess(run.id, checkResult, action);
        },
        (error) => {
          if (signal.aborted || deps.repo.get(automation.id) === null) {
            settleAbortedRun(run.id);
            return;
          }
          persistActionFailure(run.id, errorMessage(error));
        },
      ),
    };
  };

  const dispatch = async (admission: Admission): Promise<void> => {
    let claimed: { automation: Automation; run: AutomationRun } | null = null;
    let controller: AbortController | null = null;
    let retainingOwnership = false;
    try {
      claimed = beginDispatch(admission);
      if (claimed === null) {
        return;
      }
      controller = new AbortController();
      controllers.set(admission.automationId, controller);
      let checkResult: CheckResult;
      try {
        checkResult = await deps.checks.run(claimed.automation.check, {
          automationId: claimed.automation.id,
          origin: claimed.automation.origin,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || deps.repo.get(claimed.automation.id) === null) {
          settleAbortedRun(claimed.run.id);
          return;
        }
        const authMessage = detectAuthFromError(error);
        if (authMessage !== null) {
          enterNeedsAuth(claimed.run, authMessage);
          return;
        }
        persistCheckFailure(claimed.run, errorMessage(error));
        return;
      }

      if (controller.signal.aborted || deps.repo.get(claimed.automation.id) === null) {
        settleAbortedRun(claimed.run.id);
        return;
      }

      const authMessage = detectAuthFromResult(checkResult);
      if (authMessage !== null) {
        enterNeedsAuth(claimed.run, authMessage);
        return;
      }

      const latestAutomation = deps.repo.get(claimed.automation.id);
      if (!isStillActive(latestAutomation)) {
        settleAbortedRun(claimed.run.id);
        return;
      }

      const matched = evaluateCondition(latestAutomation.condition, checkResult);
      const fire = shouldFire({
        matched,
        mode: latestAutomation.mode,
        occurrenceKey: checkResult.occurrenceKey,
        lastOccurrenceKey: latestAutomation.lastOccurrenceKey,
      });

      if (!fire) {
        persistCompletedCheck(claimed.run, checkResult, activeRunSummary(checkResult));
        return;
      }

      const uncertaintyBlocks = pendingUncertaintyBlocks(latestAutomation.id);
      const acknowledged = acknowledgedTargets(
        claimed.run,
        uncertaintyBlocks,
        checkResult.occurrenceKey,
      );
      const acknowledgedIds = new Set(acknowledged.map((block) => block.runId));
      const remainingBlocks = uncertaintyBlocks.filter(
        (block) => !acknowledgedIds.has(block.runId),
      );
      const blocked =
        admission.source === 'manual'
          ? shouldBlockManualDispatch(remainingBlocks, checkResult.occurrenceKey)
          : shouldBlockAutomaticDispatch(
              uncertaintyBlocks,
              admission.source,
              checkResult.occurrenceKey,
            );
      if (blocked) {
        const block =
          pickBlockingAttempt(remainingBlocks, checkResult.occurrenceKey) ??
          pickBlockingAttempt(uncertaintyBlocks, checkResult.occurrenceKey);
        persistCompletedCheck(
          claimed.run,
          checkResult,
          blockedAttemptDetail(block!),
        );
        return;
      }

      const acting = beginAction(
        claimed.run,
        checkResult,
        claimed.automation.action.type === 'subagent'
          ? `Subagent started: ${claimed.automation.action.task}`
          : 'Running action',
      );
      if (acting === null) {
        settleAbortedRun(claimed.run.id);
        return;
      }
      const retainedAction = await fireAction(
        acting.automation,
        acting.run,
        checkResult,
        controller.signal,
      );
      if (retainedAction) {
        retainingOwnership = true;
        admission.markDispatched();
        retainedAction.completion
          .finally(() => {
            if (controllers.get(admission.automationId) === controller) {
              controllers.delete(admission.automationId);
            }
            admission.release();
          })
          .catch(() => undefined);
        return;
      }
    } catch (error) {
      admission.error = error;
      deps.onError?.(error);
      return;
    } finally {
      admission.markDispatched();
      if (
        !retainingOwnership &&
        controller !== null &&
        controllers.get(admission.automationId) === controller
      ) {
        controllers.delete(admission.automationId);
      }
      if (!retainingOwnership) {
        admission.release();
      }
    }
  };

  const pumpQueue = (): void => {
    while (
      !admissionsClosed &&
      activeWorkers < deps.config.maxConcurrentChecks &&
      queue.length > 0
    ) {
      const admission = queue.shift()!;
      admission.state = 'running';
      activeWorkers += 1;
      void dispatch(admission).finally(() => {
          activeWorkers = Math.max(0, activeWorkers - 1);
          pumpQueue();
        });
    }
  };

  return {
    async tick() {
      if (admissionsClosed) {
        return;
      }
      const now = deps.clock.now().getTime();
      const due: Admission[] = [];
      const awaiting: Promise<void>[] = [];
      for (const automation of deps.repo.list()) {
        if (!isActiveDue(automation, now)) {
          continue;
        }
        const admission = reserveRun(automation.id, 'scheduled');
        if (admission === null) {
          continue;
        }
        due.push(admission);
        awaiting.push(admission.dispatched);
      }
      pumpQueue();
      await Promise.allSettled(awaiting);
      const failure = due.find((admission) => admission.error !== null)?.error;
      if (failure !== undefined && failure !== null) {
        throw failure;
      }
    },
    async kick(id) {
      let admission = reserveRun(id, 'scheduled');
      if (admission === null) {
        const existing = deps.repo.findOpenRun(id);
        if (existing?.phase === 'queued') {
          admission = queueRecoveredRun(existing);
        }
      }
      if (admission === null) {
        return;
      }
      pumpQueue();
      await admission.dispatched;
      if (admission.error !== null) {
        throw admission.error;
      }
    },
    async runNow(id, options) {
      if (admissionsClosed) {
        throw new ConflictError('Automation scheduler is shut down');
      }
      if (blockedAutomations.has(id)) {
        throw new ConflictError('Automation is being deleted');
      }
      const { automation, run, reuseExisting } = queueManualRun(
        id,
        options?.acknowledgement,
      );
      const admission =
        run === null ? null : reuseExisting ? queueRecoveredRun(run) : createAdmission(run);
      if (admission !== null) {
        if (reuseExisting) {
          const index = queue.indexOf(admission);
          if (index > 0) {
            queue.splice(index, 1);
            queue.unshift(admission);
          }
        } else {
          queue.unshift(admission);
        }
      }
      pumpQueue();
      if (admission !== null) {
        await admission.dispatched;
        if (admission.error !== null) {
          throw admission.error;
        }
      }
      const current = deps.repo.get(id);
      return current === null ? decorateAutomation(automation) : decorateAutomation(current);
    },
    abort(id) {
      const admission = admissions.get(id);
      if (admission?.state === 'queued') {
        markQueuedCancelled(admission);
        return;
      }
      controllers.get(id)?.abort();
    },
    quiesce(id, timeoutMs) {
      blockedAutomations.add(id);
      this.abort(id);
      return this.waitForIdle(timeoutMs, id);
    },
    abortAll() {
      for (const controller of controllers.values()) {
        controller.abort();
      }
    },
    resume() {
      const now = deps.clock.isoNow();
      for (const run of deps.repo.listOpenRuns()) {
        if (run.phase === 'queued') {
          const automation = deps.repo.get(run.automationId);
          if (revalidateQueuedRun(run, automation)) {
            queueRecoveredRun(run);
            continue;
          }
          settleAbortedRun(run.id, 'Queued run was dropped before restart');
          continue;
        }
        markRecoveredRun(run);
      }
      for (const automation of deps.repo.list()) {
        if (
          automation.status === 'active' &&
          automation.nextRunAt === null &&
          deps.repo.findOpenRun(automation.id) === null
        ) {
          const nextAutomation = stampAutomation({ ...automation, nextRunAt: now });
          deps.repo.save(nextAutomation);
          emitAutomation(nextAutomation);
        }
      }
      pumpQueue();
    },
    start() {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => {
        void this.tick().catch((error) => {
          deps.onError?.(error);
        });
      }, deps.config.minIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    shutdown() {
      admissionsClosed = true;
      this.stop();
      for (const admission of [...queue]) {
        admission.release();
      }
      this.abortAll();
      notifyIdleIfNeeded();
    },
    waitForIdle(timeoutMs, automationId) {
      const idle = () => automationId === undefined
        ? ownedRuns === 0
        : !admissions.has(automationId);
      if (idle()) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let settled = false;
        const done = (idle: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timerId);
          idleWaiters.delete(notify);
          resolve(idle);
        };
        const notify = () => {
          if (idle()) done(true);
        };
        const timerId = setTimeout(() => done(false), timeoutMs);
        timerId.unref?.();
        idleWaiters.add(notify);
      });
    },
  };
}
