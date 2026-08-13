/**
 * Progress-stage modelling for long-running AI operations (Phase 5a).
 *
 * Several AI operations run as an ordered sequence of stages (e.g. the PR review
 * pipeline: distil the problem statement, then build the change graph). Each has
 * per-stage status but no *unified* progress read-out. This pure module turns a
 * list of stages into a single, testable summary — how far along the operation
 * is, which stage is current, and its overall state — so any staged AI flow can
 * render a consistent progress indicator.
 */

export type StageStatus = 'pending' | 'active' | 'done' | 'failed';

export interface ProgressStage {
  /** Stable identifier for the stage. */
  readonly id: string;
  /** Human-facing stage label. */
  readonly label: string;
  /** Current status of the stage. */
  readonly status: StageStatus;
}

export type ProgressState = 'idle' | 'running' | 'complete' | 'failed';

export interface ProgressSummary {
  /** Total number of stages. */
  readonly total: number;
  /** Stages that have completed successfully. */
  readonly done: number;
  /** Stages currently running. */
  readonly active: number;
  /** Stages that have failed. */
  readonly failed: number;
  /** Completion as a whole-number percentage (done / total). */
  readonly percent: number;
  /** Overall state of the operation. */
  readonly state: ProgressState;
  /**
   * 1-based index of the "current" stage — the first active stage, else the
   * first failed stage, else the first pending stage — or null when every stage
   * is done (or there are no stages).
   */
  readonly currentIndex: number | null;
  /** Label of the current stage, or null when none. */
  readonly currentLabel: string | null;
  /** A short, ready-to-render status line. */
  readonly headline: string;
}

function firstIndexWith(
  stages: readonly ProgressStage[],
  status: StageStatus,
): number {
  return stages.findIndex((stage) => stage.status === status);
}

/** Summarizes an ordered list of stages into a single progress read-out. */
export function summarizeStages(
  stages: readonly ProgressStage[],
): ProgressSummary {
  const total = stages.length;
  if (total === 0) {
    return {
      total: 0,
      done: 0,
      active: 0,
      failed: 0,
      percent: 0,
      state: 'idle',
      currentIndex: null,
      currentLabel: null,
      headline: 'No stages',
    };
  }

  let done = 0;
  let active = 0;
  let failed = 0;
  for (const stage of stages) {
    if (stage.status === 'done') {
      done += 1;
    } else if (stage.status === 'active') {
      active += 1;
    } else if (stage.status === 'failed') {
      failed += 1;
    }
  }

  const percent = Math.round((done / total) * 100);

  // "Current" stage: what a viewer should look at right now.
  const activeIdx = firstIndexWith(stages, 'active');
  const failedIdx = firstIndexWith(stages, 'failed');
  const pendingIdx = firstIndexWith(stages, 'pending');
  const currentIdx =
    activeIdx !== -1 ? activeIdx : failedIdx !== -1 ? failedIdx : pendingIdx;
  const currentIndex = currentIdx === -1 ? null : currentIdx + 1;
  const currentLabel = currentIdx === -1 ? null : stages[currentIdx].label;

  let state: ProgressState;
  if (done === total) {
    state = 'complete';
  } else if (active > 0 || done > 0) {
    state = 'running';
  } else if (failed > 0) {
    state = 'failed';
  } else {
    state = 'idle';
  }

  let headline: string;
  if (state === 'complete') {
    headline = 'Complete';
  } else {
    // Some stage is active/failed/pending here, so currentIdx is always >= 0.
    const label = stages[currentIdx].label;
    if (state === 'idle') {
      headline = 'Waiting to start';
    } else if (state === 'failed') {
      headline = `Failed: ${label}`;
    } else {
      headline = `Stage ${currentIdx + 1} of ${total}: ${label}`;
    }
  }

  return {
    total,
    done,
    active,
    failed,
    percent,
    state,
    currentIndex,
    currentLabel,
    headline,
  };
}
