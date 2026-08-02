import type { Clock } from '../kernel/clock.js';
import type {
  RepositoryContextStep,
} from './repository-context-contract.js';

/** Ordered, user-facing stages of the repository-analysis pipeline. */
export const REPOSITORY_CONTEXT_STEPS = [
  {
    key: 'collect-evidence',
    label: 'Collect repository evidence (resolve HEAD, read key files)',
  },
  { key: 'analyze', label: 'Analyze repository with AI' },
  { key: 'persist', label: 'Store repository context' },
] as const;

/** Step key type derived from the ordered pipeline definition. */
export type RepositoryContextStepKey =
  (typeof REPOSITORY_CONTEXT_STEPS)[number]['key'];

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Repository analysis failed';
}

/** Builds the initial all-pending step list for a fresh generation attempt. */
export function initialRepositoryContextSteps(): RepositoryContextStep[] {
  return REPOSITORY_CONTEXT_STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    status: 'pending',
    detail: null,
    startedAt: null,
    finishedAt: null,
  }));
}

/** Runs pipeline stages while recording per-step status, detail, and timing. */
export interface RepositoryContextStepTracker {
  /** Current immutable snapshot of every tracked step. */
  snapshot(): RepositoryContextStep[];
  /** The step that failed, if any. */
  failedStep(): RepositoryContextStep | null;
  /** Key of the failed step, or null when no step has failed. */
  failedStepKey(): string | null;
  /**
   * Executes one stage: marks it running, runs `fn` (which may report progress
   * detail), then marks it ok. On error the step is marked failed with the error
   * detail, all later steps are marked skipped, and the error is rethrown.
   */
  run<T>(
    key: RepositoryContextStepKey,
    fn: (report: (detail: string) => void) => Promise<T>,
  ): Promise<T>;
}

export function createRepositoryContextStepTracker(deps: {
  clock: Clock;
  /** Invoked after every step transition with a fresh snapshot. */
  onChange: (steps: RepositoryContextStep[]) => void;
}): RepositoryContextStepTracker {
  const steps = initialRepositoryContextSteps();
  const index = new Map(steps.map((step, position) => [step.key, position]));

  const snapshot = (): RepositoryContextStep[] =>
    steps.map((step) => ({ ...step }));
  const emit = (): void => deps.onChange(snapshot());

  return {
    snapshot,
    failedStep: () => {
      const failed = steps.find((step) => step.status === 'failed');
      return failed ? { ...failed } : null;
    },
    failedStepKey: () => {
      const failed = steps.find((step) => step.status === 'failed');
      return failed ? failed.key : null;
    },
    async run(key, fn) {
      const step = steps[index.get(key) as number];
      step.status = 'running';
      step.startedAt = deps.clock.isoNow();
      step.detail = null;
      emit();
      try {
        const result = await fn((detail) => {
          step.detail = detail;
          emit();
        });
        step.status = 'ok';
        step.finishedAt = deps.clock.isoNow();
        emit();
        return result;
      } catch (error) {
        const failedAt = deps.clock.isoNow();
        step.status = 'failed';
        step.finishedAt = failedAt;
        step.detail = errorDetail(error);
        for (const later of steps) {
          if (later.status === 'pending') {
            later.status = 'skipped';
          }
        }
        emit();
        throw error;
      }
    },
  };
}
