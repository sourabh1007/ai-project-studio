/**
 * Persistent, per-feature store for the Review Board's AI analysis run.
 *
 * The analysis is **parallel and self-healing**: perspectives are reviewed
 * concurrently up to the warm metasession capacity (so 5 warm sessions judge 5
 * perspectives at once instead of one-by-one), each request is retried with
 * backoff before it is surfaced as an error, and the whole run keeps going even
 * when the Review Board page unmounts (the reviewer switched tabs/windows). The
 * page is a thin subscriber over this store via `useSyncExternalStore`, so
 * navigating away and back shows the live progress instead of restarting.
 *
 * All pure decision logic lives in `../../lib/review-board-progress.ts` (which
 * the UI coverage gate exercises); this module is the thin, stateful IO shell
 * that drives it — the same ports-and-adapters split the backend uses.
 */

import type {
  MetaPoolsStatus,
  PerspectiveAnalysis,
  PerspectiveCheck,
  PrReview,
  RationalePoint,
  ReviewBoard,
  ReviewBoardRatingChange,
} from '../../lib/types.js';
import { ApiError } from '../../lib/api.js';
import { metaConcurrency } from '../../lib/meta-concurrency.js';
import {
  applyAgentRatingChange,
  mapWithConcurrency,
  mergeAnalyzedPerspective,
  runWithRetry,
  RetryCancelledError,
} from '../../lib/review-board-progress.js';
import {
  clearPerspectivesReviewed,
  emptySignoff,
  parseSignoff,
  withPerspectiveReviewed,
  withPrReviewCleared,
  withPrReviewed,
  type SignoffState,
} from '../../lib/review-signoff.js';
import {
  parseResolutions,
  withResolution,
  type FindingResolution,
  type FindingResolutionMap,
} from '../../lib/review-format.js';

/**
 * Default parallelism when the warm-pool status can't be read — a single turn
 * at a time, matching the safe cold-path behaviour.
 */
const FALLBACK_CONCURRENCY = 1;
/** Attempts (initial + retries) before a perspective is marked failed. */
const MAX_ATTEMPTS = 3;
/** Backoff before the retry that follows a failed attempt (grows per attempt). */
const RETRY_BACKOFF_MS = 1_500;
/** Poll interval while waiting for the change graph to rebuild after a pull. */
const PREP_POLL_MS = 1_500;
/** Give up waiting for the change-graph rebuild after this long. */
const PREP_TIMEOUT_MS = 600_000;

/** The subset of the API client the store drives. */
export interface ReviewBoardRunApi {
  getReviewBoard(featureId: string): Promise<ReviewBoard>;
  analyzeReviewBoardPerspective(
    featureId: string,
    perspectiveId: string,
    signal?: AbortSignal,
  ): Promise<PerspectiveAnalysis>;
  /** Read the current PR review (used to poll the change-graph rebuild). */
  getPrReview(featureId: string): Promise<PrReview>;
  /** Re-provision the worktree to the latest remote head and rebuild. */
  pullLatestPrReview(featureId: string): Promise<PrReview>;
  /**
   * Live warm-metasession pool status, used to size how many perspectives run
   * in parallel so warm capacity is exploited. Optional so leaner callers/tests
   * can omit it; absent or failing falls back to one-at-a-time.
   */
  getMetaPools?(): Promise<MetaPoolsStatus>;
}

export type PerspectiveStatus =
  | 'idle'
  | 'pending'
  | 'analyzing'
  | 'retrying'
  | 'done'
  | 'skipped'
  | 'error';

export interface PerspectiveProgress {
  status: PerspectiveStatus;
  skipReason: string | null;
  /** What the reviewer checked to justify the rating, or null. */
  checked: string | null;
  /** Evidence-backed labeled narrative justifying the rating. */
  rationale: RationalePoint[];
  /** Line-by-line audit trail of what was inspected and each outcome. */
  checks: PerspectiveCheck[];
  error: string | null;
  /** 1-based attempt currently running (>1 means a self-healing retry). */
  attempt: number;
  /**
   * Set when the review agent revised this rating during a discussion. Records
   * why the agent was convinced so the change is auditable in the detail panel.
   */
  agentAdjustment?: { justification: string } | null;
}

export interface ReviewBoardRunState {
  board: ReviewBoard | null;
  loading: boolean;
  loadError: string | null;
  analyzed: boolean;
  running: boolean;
  progress: Record<string, PerspectiveProgress>;
  /**
   * "Take latest" preparation phase shown before an analysis pass: re-provision
   * the PR worktree to the latest remote head, then wait for the change graph to
   * rebuild. `active` drives the progress banner; `error` surfaces a failure.
   */
  prep: PrepPhase;
  /** Human sign-off layered over the AI verdict; persisted per feature. */
  signoff: SignoffState;
  /** Human resolve/ignore decisions per finding; persisted per feature. */
  resolutions: FindingResolutionMap;
}

/** Progress of the optional "take latest from remote" step before analysis. */
export interface PrepPhase {
  active: boolean;
  message: string;
  error: string | null;
}

const IDLE_PREP: PrepPhase = { active: false, message: '', error: null };

const EMPTY_STATE: ReviewBoardRunState = {
  board: null,
  loading: false,
  loadError: null,
  analyzed: false,
  running: false,
  progress: {},
  prep: IDLE_PREP,
  signoff: emptySignoff(),
  resolutions: {},
};

/** Internal per-feature record: public state plus the live run's control. */
interface FeatureRecord {
  state: ReviewBoardRunState;
  runToken: number;
  controller: AbortController | null;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** A thrown value that represents an aborted/cancelled request. */
function isAbort(error: unknown): boolean {
  return (
    error instanceof RetryCancelledError ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

class ReviewBoardRunStore {
  private readonly records = new Map<string, FeatureRecord>();
  private readonly listeners = new Map<string, Set<() => void>>();

  private record(featureId: string): FeatureRecord {
    let rec = this.records.get(featureId);
    if (!rec) {
      rec = {
        state: {
          ...EMPTY_STATE,
          signoff: this.loadSignoff(featureId),
          resolutions: this.loadResolutions(featureId),
        },
        runToken: 0,
        controller: null,
      };
      this.records.set(featureId, rec);
    }
    return rec;
  }

  /** localStorage key holding a feature's persisted human sign-off. */
  private signoffKey(featureId: string): string {
    return `rb-signoff:${featureId}`;
  }

  /** Read persisted sign-off, tolerating an absent or corrupt store. */
  private loadSignoff(featureId: string): SignoffState {
    try {
      const raw = globalThis.localStorage?.getItem(this.signoffKey(featureId));
      return raw ? parseSignoff(JSON.parse(raw)) : emptySignoff();
    } catch {
      return emptySignoff();
    }
  }

  /** Persist sign-off, ignoring any storage failure (private mode, quota). */
  private saveSignoff(featureId: string, signoff: SignoffState): void {
    try {
      globalThis.localStorage?.setItem(
        this.signoffKey(featureId),
        JSON.stringify(signoff),
      );
    } catch {
      /* best-effort persistence only */
    }
  }

  /** Apply a pure transform to the sign-off, then persist and emit. */
  private updateSignoff(
    featureId: string,
    change: (prev: SignoffState) => SignoffState,
  ): void {
    this.update(featureId, (prev) => {
      const signoff = change(prev.signoff);
      if (signoff === prev.signoff) return prev;
      this.saveSignoff(featureId, signoff);
      return { ...prev, signoff };
    });
  }

  /** Mark a single perspective reviewed (or clear it) by the human reviewer. */
  setPerspectiveReviewed(
    featureId: string,
    perspectiveId: string,
    reviewed: boolean,
  ): void {
    this.updateSignoff(featureId, (prev) =>
      withPerspectiveReviewed(
        prev,
        perspectiveId,
        reviewed ? new Date().toISOString() : null,
      ),
    );
  }

  /** Mark the whole PR reviewed; the pure guard ignores it unless all are. */
  markPrReviewed(featureId: string, perspectiveIds: readonly string[]): void {
    this.updateSignoff(featureId, (prev) =>
      withPrReviewed(prev, perspectiveIds, new Date().toISOString()),
    );
  }

  /** Re-open a PR that was marked reviewed, keeping per-perspective sign-offs. */
  clearPrReviewed(featureId: string): void {
    this.updateSignoff(featureId, (prev) => withPrReviewCleared(prev));
  }

  /** localStorage key holding a feature's finding resolve/ignore decisions. */
  private resolutionsKey(featureId: string): string {
    return `rb-resolutions:${featureId}`;
  }

  /** Read persisted resolutions, tolerating an absent or corrupt store. */
  private loadResolutions(featureId: string): FindingResolutionMap {
    try {
      const raw = globalThis.localStorage?.getItem(
        this.resolutionsKey(featureId),
      );
      return raw ? parseResolutions(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  }

  /** Set (or clear, when null) the reviewer's decision for a single finding. */
  setFindingResolution(
    featureId: string,
    findingId: string,
    resolution: FindingResolution | null,
  ): void {
    this.update(featureId, (prev) => {
      const resolutions = withResolution(prev.resolutions, findingId, resolution);
      try {
        globalThis.localStorage?.setItem(
          this.resolutionsKey(featureId),
          JSON.stringify(resolutions),
        );
      } catch {
        /* best-effort persistence only */
      }
      return { ...prev, resolutions };
    });
  }

  /** Current immutable snapshot for a feature (stable identity between edits). */
  getState(featureId: string): ReviewBoardRunState {
    return this.record(featureId).state;
  }

  subscribe(featureId: string, listener: () => void): () => void {
    let set = this.listeners.get(featureId);
    if (!set) {
      set = new Set();
      this.listeners.set(featureId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private emit(featureId: string): void {
    const set = this.listeners.get(featureId);
    if (set) for (const l of set) l();
  }

  private update(
    featureId: string,
    change: (prev: ReviewBoardRunState) => ReviewBoardRunState,
  ): void {
    const rec = this.record(featureId);
    rec.state = change(rec.state);
    this.emit(featureId);
  }

  private setProgress(
    featureId: string,
    perspectiveId: string,
    progress: PerspectiveProgress,
  ): void {
    this.update(featureId, (prev) => ({
      ...prev,
      progress: { ...prev.progress, [perspectiveId]: progress },
    }));
  }

  /**
   * Load the clean board. Never disturbs an in-flight run (so returning to the
   * tab keeps its progress); pass `force` to hard-reload from scratch.
   */
  async load(
    featureId: string,
    api: ReviewBoardRunApi,
    force = false,
  ): Promise<void> {
    const rec = this.record(featureId);
    if (!force && (rec.state.loading || rec.state.running || rec.state.board)) {
      return;
    }
    this.update(featureId, (prev) => ({
      ...prev,
      loading: true,
      loadError: null,
    }));
    try {
      const board = await api.getReviewBoard(featureId);
      this.update(featureId, (prev) => ({
        ...prev,
        board,
        loading: false,
      }));
    } catch (error) {
      this.update(featureId, (prev) => ({
        ...prev,
        loading: false,
        loadError: messageOf(error, 'Failed to load the review board.'),
      }));
    }
  }

  /** Abort any in-flight run and reload the clean board from scratch. */
  reset(featureId: string, api: ReviewBoardRunApi): void {
    const rec = this.record(featureId);
    rec.runToken += 1;
    rec.controller?.abort();
    rec.controller = null;
    rec.state = {
      ...EMPTY_STATE,
      // Keep the current board visible until the reload lands, and preserve the
      // reviewer's sign-off and finding decisions — resetting the AI run must
      // not discard human decisions.
      board: rec.state.board,
      signoff: rec.state.signoff,
      resolutions: rec.state.resolutions,
    };
    this.emit(featureId);
    void this.load(featureId, api, true);
  }

  /**
   * Take the latest from the remote before analysing: re-provision the PR
   * worktree to the current remote head, then poll until the change graph has
   * rebuilt (analysis reads the change graph, so it must be `ready` first).
   * Returns `true` on success, `false` if the reviewer should not proceed
   * (aborted by a newer run, or the pull/rebuild failed — surfaced via `prep`).
   */
  /**
   * How many perspectives to review in parallel this pass: the warm-pool
   * capacity so ready metasessions are all put to work, or one-at-a-time when
   * the pool status can't be read (or warm pools are off).
   */
  private async resolveConcurrency(api: ReviewBoardRunApi): Promise<number> {
    try {
      const status = await api.getMetaPools?.();
      return metaConcurrency(status);
    } catch {
      return FALLBACK_CONCURRENCY;
    }
  }

  private async takeLatest(
    featureId: string,
    api: ReviewBoardRunApi,
  ): Promise<boolean> {
    const rec = this.record(featureId);
    rec.controller?.abort();
    rec.controller = null;
    const token = (rec.runToken += 1);
    const isStale = () => this.record(featureId).runToken !== token;

    this.setPrep(featureId, {
      active: true,
      message: 'Fetching the latest from the remote…',
      error: null,
    });
    try {
      await api.pullLatestPrReview(featureId);
      if (isStale()) return false;
      this.setPrep(featureId, {
        active: true,
        message: 'Rebuilding the change graph…',
        error: null,
      });
      const startedAt = Date.now();
      const deadline = startedAt + PREP_TIMEOUT_MS;
      for (;;) {
        if (isStale()) return false;
        const review = await api.getPrReview(featureId);
        const status = review.changeGraph.status;
        if (status === 'ready') break;
        if (status === 'failed') {
          throw new Error(
            review.changeGraph.failure?.message ??
              'The change graph failed to rebuild.',
          );
        }
        if (Date.now() > deadline) {
          throw new Error('Timed out waiting for the change graph to rebuild.');
        }
        // Large PRs build big reference graphs (hundreds of nodes), so surface
        // the elapsed time to make clear the rebuild is still progressing.
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        this.setPrep(featureId, {
          active: true,
          message: `Rebuilding the change graph… (${elapsed}s)`,
          error: null,
        });
        await new Promise((r) => setTimeout(r, PREP_POLL_MS));
      }
      if (isStale()) return false;
      this.setPrep(featureId, IDLE_PREP);
      return true;
    } catch (error) {
      if (isStale() || isAbort(error)) return false;
      this.setPrep(featureId, {
        active: false,
        message: '',
        error: messageOf(error, 'Failed to take the latest from the remote.'),
      });
      return false;
    }
  }

  /** Replace the take-latest prep phase and notify subscribers. */
  private setPrep(featureId: string, prep: PrepPhase): void {
    this.update(featureId, (prev) => ({ ...prev, prep }));
  }

  /** Clear a lingering take-latest error (e.g. when the reviewer retries). */
  clearPrepError(featureId: string): void {
    this.update(featureId, (prev) =>
      prev.prep.error ? { ...prev, prep: IDLE_PREP } : prev,
    );
  }

  /**
   * Run the sequential, self-healing analysis over every perspective. Safe to
   * call repeatedly — a fresh call supersedes any prior run (aborting it) so the
   * "Analyze with AI" button always starts a clean pass. When `takeLatest` is
   * set, the PR worktree is re-provisioned to the latest remote head (and the
   * change graph rebuilt) before the pass begins.
   */
  async analyze(
    featureId: string,
    api: ReviewBoardRunApi,
    opts: { takeLatest?: boolean } = {},
  ): Promise<void> {
    if (opts.takeLatest && !(await this.takeLatest(featureId, api))) return;
    // Take the latest board before a full pass, so the analysis reflects the
    // current PR state rather than a stale snapshot from a previous visit.
    await this.load(featureId, api, true);
    const rec = this.record(featureId);
    const board = rec.state.board;
    if (!board) return;
    const ids = board.perspectives.map((p) => p.id);

    // A fresh full pass re-rates every perspective, so any prior human sign-off
    // (and the PR sign-off) is stale — clear it so the reviewer re-confirms.
    this.updateSignoff(featureId, (prev) =>
      clearPerspectivesReviewed(prev, ids),
    );

    rec.controller?.abort();
    const controller = new AbortController();
    rec.controller = controller;
    const token = (rec.runToken += 1);

    this.update(featureId, (prev) => ({
      ...prev,
      analyzed: true,
      running: true,
      progress: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            status: 'pending',
            skipReason: null,
            checked: null,
            rationale: [],
            checks: [],
            error: null,
            attempt: 0,
          },
        ]),
      ),
    }));

    const isStale = () => this.record(featureId).runToken !== token;

    const concurrency = await this.resolveConcurrency(api);
    await mapWithConcurrency(ids, concurrency, async (id) => {
      if (isStale()) return;
      try {
        const result = await runWithRetry(
          async (attempt) => {
            this.setProgress(featureId, id, {
              status: attempt > 1 ? 'retrying' : 'analyzing',
              skipReason: null,
              checked: null,
              rationale: [],
              checks: [],
              error: null,
              attempt,
            });
            return await api.analyzeReviewBoardPerspective(
              featureId,
              id,
              controller.signal,
            );
          },
          {
            attempts: MAX_ATTEMPTS,
            delay: (ms) => new Promise((r) => setTimeout(r, ms)),
            backoffMs: (attempt) => RETRY_BACKOFF_MS * attempt,
            cancelled: () => isStale() || controller.signal.aborted,
            shouldRetry: (error) => !isAbort(error),
          },
        );
        if (isStale()) return;
        this.update(featureId, (prev) => ({
          ...prev,
          board: prev.board
            ? mergeAnalyzedPerspective(prev.board, result.perspective)
            : prev.board,
        }));
        this.setProgress(featureId, id, {
          status: result.skipped ? 'skipped' : 'done',
          skipReason: result.skipReason,
          checked: result.summary,
          rationale: result.rationale,
          checks: result.checks,
          error: null,
          attempt: 0,
        });
      } catch (error) {
        if (isStale() || isAbort(error)) return;
        this.setProgress(featureId, id, {
          status: 'error',
          skipReason: null,
          checked: null,
          rationale: [],
          checks: [],
          error: messageOf(error, 'This perspective could not be analysed.'),
          attempt: 0,
        });
      }
    });

    if (!isStale()) {
      this.update(featureId, (prev) => ({ ...prev, running: false }));
    }
  }

  /**
   * Analyze a single perspective on demand, leaving every other perspective's
   * rating and findings untouched. The backend reads the latest persisted PR
   * review on each call, so this always re-rates against the current state. Used
   * when the reviewer asks to (re)analyze just the perspective they are looking
   * at rather than the whole board.
   */
  async analyzeOne(
    featureId: string,
    perspectiveId: string,
    api: ReviewBoardRunApi,
    opts: { takeLatest?: boolean } = {},
  ): Promise<void> {
    if (opts.takeLatest && !(await this.takeLatest(featureId, api))) return;
    const rec = this.record(featureId);
    if (!rec.state.board) return;

    // Re-rating this perspective invalidates its human sign-off (and the PR's).
    this.updateSignoff(featureId, (prev) =>
      clearPerspectivesReviewed(prev, [perspectiveId]),
    );

    const controller = rec.controller?.signal.aborted
      ? new AbortController()
      : (rec.controller ?? new AbortController());
    rec.controller = controller;
    const token = rec.runToken;
    const isStale = () => this.record(featureId).runToken !== token;

    this.update(featureId, (prev) => ({
      ...prev,
      analyzed: true,
      running: true,
    }));
    this.setProgress(featureId, perspectiveId, {
      status: 'pending',
      skipReason: null,
      checked: null,
      rationale: [],
      checks: [],
      error: null,
      attempt: 0,
    });

    try {
      const result = await runWithRetry(
        async (attempt) => {
          this.setProgress(featureId, perspectiveId, {
            status: attempt > 1 ? 'retrying' : 'analyzing',
            skipReason: null,
            checked: null,
            rationale: [],
            checks: [],
            error: null,
            attempt,
          });
          return await api.analyzeReviewBoardPerspective(
            featureId,
            perspectiveId,
            controller.signal,
          );
        },
        {
          attempts: MAX_ATTEMPTS,
          delay: (ms) => new Promise((r) => setTimeout(r, ms)),
          backoffMs: (attempt) => RETRY_BACKOFF_MS * attempt,
          cancelled: () => isStale() || controller.signal.aborted,
          shouldRetry: (error) => !isAbort(error),
        },
      );
      if (!isStale()) {
        this.update(featureId, (prev) => ({
          ...prev,
          board: prev.board
            ? mergeAnalyzedPerspective(prev.board, result.perspective)
            : prev.board,
        }));
        this.setProgress(featureId, perspectiveId, {
          status: result.skipped ? 'skipped' : 'done',
          skipReason: result.skipReason,
          checked: result.summary,
          rationale: result.rationale,
          checks: result.checks,
          error: null,
          attempt: 0,
        });
      }
    } catch (error) {
      if (!isStale() && !isAbort(error)) {
        this.setProgress(featureId, perspectiveId, {
          status: 'error',
          skipReason: null,
          checked: null,
          rationale: [],
          checks: [],
          error: messageOf(error, 'This perspective could not be analysed.'),
          attempt: 0,
        });
      }
    }

    if (!isStale()) {
      this.update(featureId, (prev) => ({ ...prev, running: false }));
    }
  }

  /** Re-run only the perspectives that ended in an error (self-heal retry). */
  async retryFailed(featureId: string, api: ReviewBoardRunApi): Promise<void> {
    const rec = this.record(featureId);
    const failed = Object.entries(rec.state.progress)
      .filter(([, p]) => p.status === 'error')
      .map(([id]) => id);
    if (failed.length === 0) return;

    const controller = rec.controller?.signal.aborted
      ? new AbortController()
      : (rec.controller ?? new AbortController());
    rec.controller = controller;
    const token = rec.runToken;
    const isStale = () => this.record(featureId).runToken !== token;

    this.update(featureId, (prev) => ({
      ...prev,
      running: true,
      progress: {
        ...prev.progress,
        ...Object.fromEntries(
          failed.map((id) => [
            id,
            {
            status: 'pending',
            skipReason: null,
            checked: null,
            rationale: [],
            checks: [],
            error: null,
            attempt: 0,
          },
          ]),
        ),
      },
    }));

    const concurrency = await this.resolveConcurrency(api);
    await mapWithConcurrency(failed, concurrency, async (id) => {
      if (isStale()) return;
      try {
        const result = await runWithRetry(
          async (attempt) => {
            this.setProgress(featureId, id, {
              status: attempt > 1 ? 'retrying' : 'analyzing',
              skipReason: null,
              checked: null,
              rationale: [],
              checks: [],
              error: null,
              attempt,
            });
            return await api.analyzeReviewBoardPerspective(
              featureId,
              id,
              controller.signal,
            );
          },
          {
            attempts: MAX_ATTEMPTS,
            delay: (ms) => new Promise((r) => setTimeout(r, ms)),
            backoffMs: (attempt) => RETRY_BACKOFF_MS * attempt,
            cancelled: () => isStale() || controller.signal.aborted,
            shouldRetry: (error) => !isAbort(error),
          },
        );
        if (isStale()) return;
        this.update(featureId, (prev) => ({
          ...prev,
          board: prev.board
            ? mergeAnalyzedPerspective(prev.board, result.perspective)
            : prev.board,
        }));
        this.setProgress(featureId, id, {
          status: result.skipped ? 'skipped' : 'done',
          skipReason: result.skipReason,
          checked: result.summary,
          rationale: result.rationale,
          checks: result.checks,
          error: null,
          attempt: 0,
        });
      } catch (error) {
        if (isStale() || isAbort(error)) return;
        this.setProgress(featureId, id, {
          status: 'error',
          skipReason: null,
          checked: null,
          rationale: [],
          checks: [],
          error: messageOf(error, 'This perspective could not be analysed.'),
          attempt: 0,
        });
      }
    });

    if (!isStale()) {
      this.update(featureId, (prev) => ({ ...prev, running: false }));
    }
  }

  /**
   * Apply a rating change the review agent proposed during a discussion. The
   * agent only returns one once it is convinced by concrete evidence, so this
   * re-rates the perspective, refreshes its "what was checked" summary and
   * verdict rationale, and records the justification for the audit trail. A
   * change for an unknown perspective is ignored.
   */
  applyRatingChange(
    featureId: string,
    change: ReviewBoardRatingChange,
  ): void {
    const rec = this.record(featureId);
    const existing = rec.state.progress[change.perspectiveId];
    if (!rec.state.board || !existing) return;
    this.update(featureId, (prev) => ({
      ...prev,
      board: prev.board ? applyAgentRatingChange(prev.board, change) : prev.board,
      progress: {
        ...prev.progress,
        [change.perspectiveId]: {
          ...existing,
          checked: change.summary,
          rationale: change.rationale,
          agentAdjustment: { justification: change.justification },
        },
      },
    }));
  }
}

/** The app-wide singleton — one live run per feature, shared across mounts. */
export const reviewBoardRunStore = new ReviewBoardRunStore();
