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
  ReviewBoardPerspectiveEvent,
  ReviewBoardRatingChange,
} from '../../lib/types.js';
import { ApiError } from '../../lib/api.js';
import { metaConcurrency } from '../../lib/meta-concurrency.js';
import {
  applyAgentRatingChange,
  mapWithDynamicConcurrency,
  mergeAnalyzedPerspective,
  runWithRetry,
  RetryCancelledError,
} from '../../lib/review-board-progress.js';
import {
  beginSignoffIdentityRefresh,
  canCertifySignoff,
  clearPerspectivesReviewed,
  emptySignoff,
  parseSignoff,
  recordSignoffIdentityFailure,
  resolveSignoffIdentity,
  syncSignoffIdentity,
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
const BULK_REVIEW_CONCURRENCY = 3;

/** The subset of the API client the store drives. */
export interface ReviewBoardRunApi {
  getReviewBoard(featureId: string): Promise<ReviewBoard>;
  analyzeReviewBoardPerspective(
    featureId: string,
    perspectiveId: string,
    signal?: AbortSignal,
  ): Promise<PerspectiveAnalysis>;
  /**
   * Server-side whole-board fan-out. The backend runs every perspective across
   * the warm pool (reserving one session) and streams one event per lens as it
   * settles, so the parallelism is bounded by the pool rather than the browser's
   * per-origin socket cap. `onEvent` is called for each streamed event; the
   * promise resolves when the stream ends.
   */
  analyzeReviewBoardPerspectives(
    featureId: string,
    onEvent: (event: ReviewBoardPerspectiveEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Read the current PR review (used to poll the change-graph rebuild). */
  getPrReview(featureId: string): Promise<PrReview>;
  retryPrReviewStep?(featureId: string, step: 'changeGraph'): Promise<PrReview>;
  settleReviewBoardQueue?(featureId: string): Promise<unknown>;
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
  /** Actual analysis time, including retries; excludes time waiting in the queue. */
  timing?: ReviewTiming | null;
  /**
   * Set when the review agent revised this rating during a discussion. Records
   * why the agent was convinced so the change is auditable in the detail panel.
   */
  agentAdjustment?: { justification: string } | null;
}

export interface ReviewTiming {
  startedAt: number;
  finishedAt: number | null;
}

export interface ReviewBoardRunState {
  board: ReviewBoard | null;
  loading: boolean;
  loadError: string | null;
  analyzed: boolean;
  running: boolean;
  queued: boolean;
  /** Latest full review: evidence preparation + analysis, excluding its queue wait. */
  timing: ReviewTiming | null;
  preparationTiming: ReviewTiming | null;
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
  queued: false,
  timing: null,
  preparationTiming: null,
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
  loadToken: number;
  loadPromise: Promise<void> | null;
  loadMode: 'refresh' | 'force' | null;
  timingToken: number;
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

export class ReviewBoardRunStore {
  private readonly records = new Map<string, FeatureRecord>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private bulkQueue: { featureId: string; api: ReviewBoardRunApi; retry: boolean }[] = [];
  private readonly bulkActive = new Set<string>();
  private readonly autoScheduled = new Set<string>();
  private readonly removed = new Set<string>();

  /** Stop queued and active work for a feature removed from the workspace. */
  remove(featureId: string): void {
    this.removed.add(featureId);
    this.bulkQueue = this.bulkQueue.filter((job) => job.featureId !== featureId);
    const rec = this.records.get(featureId);
    if (rec) {
      rec.runToken += 1;
      rec.loadToken += 1;
      rec.timingToken += 1;
      rec.controller?.abort();
      rec.state = { ...EMPTY_STATE };
      this.emit(featureId);
    }
  }

  /** App-owned queue: importing or viewing a batch never depends on a mounted tracker. */
  enqueueBulk(featureIds: string[], api: ReviewBoardRunApi, opts: { retry?: boolean } = {}): void {
    for (const featureId of featureIds) {
      const state = this.getState(featureId);
      if (this.removed.has(featureId) || this.bulkActive.has(featureId) || this.bulkQueue.some((job) => job.featureId === featureId) ||
          state.running || state.prep.active ||
          (!opts.retry && (this.autoScheduled.has(featureId) || state.analyzed || state.loadError || state.prep.error))) continue;
      this.autoScheduled.add(featureId);
      this.bulkQueue.push({ featureId, api, retry: opts.retry === true });
      this.update(featureId, (prev) => ({ ...prev, queued: true }));
    }
    this.pumpBulk();
  }

  private pumpBulk(): void {
    while (this.bulkActive.size < BULK_REVIEW_CONCURRENCY && this.bulkQueue.length) {
      const job = this.bulkQueue.shift()!;
      const state = this.getState(job.featureId);
      if (state.running || state.prep.active || (!job.retry && state.analyzed)) {
        this.update(job.featureId, (prev) => ({ ...prev, queued: false }));
        continue;
      }
      this.bulkActive.add(job.featureId);
      void this.analyze(job.featureId, job.api, { waitForGraph: true })
        .catch((error) => this.update(job.featureId, (prev) => ({
          ...prev, queued: false,
          prep: { active: false, message: '', error: messageOf(error, 'Failed to start the review.') },
        })))
        .finally(() => {
          this.bulkActive.delete(job.featureId);
          this.pumpBulk();
        });
    }
  }

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
        loadToken: 0,
        loadPromise: null,
        loadMode: null,
        timingToken: 0,
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
    if (reviewed && !canCertifySignoff(this.record(featureId).state.signoff)) {
      return;
    }
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
    if (!canCertifySignoff(this.record(featureId).state.signoff)) {
      return;
    }
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
    if (this.removed.has(featureId)) return;
    const rec = this.record(featureId);
    rec.state = change(rec.state);
    this.emit(featureId);
  }

  private setProgress(
    featureId: string,
    perspectiveId: string,
    progress: PerspectiveProgress,
  ): void {
    this.update(featureId, (prev) => {
      let timing = prev.progress[perspectiveId]?.timing ?? null;
      if (progress.status === 'pending' || progress.status === 'idle') timing = null;
      else if (progress.status === 'analyzing' || progress.status === 'retrying') {
        if (!timing || timing.finishedAt !== null) timing = { startedAt: Date.now(), finishedAt: null };
      } else if (timing && timing.finishedAt === null) {
        timing = { ...timing, finishedAt: Date.now() };
      }
      return {
        ...prev,
        progress: { ...prev.progress, [perspectiveId]: { ...progress, timing } },
      };
    });
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
    if (this.removed.has(featureId)) return;
    const rec = this.record(featureId);
    if (!force && (rec.state.running || rec.state.prep.active || rec.state.queued)) {
      return rec.loadPromise ?? Promise.resolve();
    }
    if (rec.loadPromise && (!force || rec.loadMode === 'force')) {
      return rec.loadPromise;
    }
    const token = rec.loadToken + 1;
    rec.loadToken = token;
    rec.loadMode = force ? 'force' : 'refresh';
    this.update(featureId, (prev) => ({
      ...prev,
      loading: true,
      loadError: null,
      signoff: beginSignoffIdentityRefresh(prev.signoff),
    }));
    rec.loadPromise = (async () => {
      try {
        const board = await api.getReviewBoard(featureId);
        if (this.record(featureId).loadToken !== token) {
          return;
        }
        this.update(featureId, (prev) => {
          const keepResults = !force && prev.board !== null &&
            prev.board.pull.headSha === board.pull.headSha &&
            prev.board.reviewUpdatedAt === board.reviewUpdatedAt &&
            prev.board.perspectives.length === board.perspectives.length &&
            prev.board.perspectives.every((p) => board.perspectives.some((next) => next.id === p.id));
          let refreshed = board;
          const restored: Record<string, PerspectiveProgress> = {};
          if (!force) {
            for (const perspective of board.perspectives) {
              const analysis = board.analyses?.[perspective.id];
              if (!analysis || analysis.perspectiveId !== perspective.id ||
                  analysis.perspective.id !== perspective.id) continue;
              restored[perspective.id] = {
                status: analysis.skipped ? 'skipped' : 'done',
                skipReason: analysis.skipReason, checked: analysis.summary,
                rationale: analysis.rationale, checks: analysis.checks, error: null, attempt: 0,
              };
            }
          }
          if (keepResults) {
            for (const perspective of prev.board!.perspectives) {
              const status = prev.progress[perspective.id]?.status;
              if (status === 'done' || status === 'skipped') {
                refreshed = mergeAnalyzedPerspective(refreshed, perspective);
              }
            }
          }
          const signoff = syncSignoffIdentity(
            prev.signoff,
            resolveSignoffIdentity(board),
            new Date().toISOString(),
          );
          this.saveSignoff(featureId, signoff);
          return {
            ...prev,
            board: refreshed,
            progress: keepResults ? { ...restored, ...prev.progress } : restored,
            analyzed: (keepResults && prev.analyzed) || Object.keys(restored).length > 0,
            timing: keepResults || prev.timing?.finishedAt === null ? prev.timing : null,
            preparationTiming: keepResults || prev.timing?.finishedAt === null ? prev.preparationTiming : null,
            loading: false,
            loadError: null,
            signoff,
          };
        });
      } catch (error) {
        if (this.record(featureId).loadToken !== token) {
          return;
        }
        this.update(featureId, (prev) => {
          const signoff = recordSignoffIdentityFailure(
            prev.signoff,
            messageOf(error, 'Failed to refresh the review board.'),
          );
          this.saveSignoff(featureId, signoff);
          return {
            ...prev,
            loading: false,
            loadError: messageOf(error, 'Failed to load the review board.'),
            signoff,
          };
        });
      } finally {
        const current = this.record(featureId);
        if (current.loadToken === token) {
          current.loadPromise = null;
          current.loadMode = null;
        }
      }
    })();
    return rec.loadPromise;
  }

  /** Abort any in-flight run and reload the clean board from scratch. */
  reset(featureId: string, api: ReviewBoardRunApi): void {
    this.autoScheduled.add(featureId);
    const rec = this.record(featureId);
    rec.runToken += 1;
    rec.timingToken += 1;
    this.bulkQueue = this.bulkQueue.filter((job) => job.featureId !== featureId);
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
    void api.settleReviewBoardQueue?.(featureId).catch((error) => {
      this.setPrep(featureId, { active: false, message: '', error: messageOf(error, 'Could not cancel the saved review queue entry.') });
    });
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
    const status = await api.getMetaPools?.();
    return metaConcurrency(status);
  }

  /**
   * A per-run concurrency getter for {@link mapWithDynamicConcurrency} that is
   * resilient to a *starved* pool poll. The fan-out turns and the periodic
   * `/meta/pools` poll compete for the same handful of browser sockets, so under
   * load the poll can hang or time out. If every failure collapsed the target to
   * {@link FALLBACK_CONCURRENCY}, one unlucky poll would erase capacity we had
   * already discovered and stall further scale-up. Instead we remember the last
   * successfully observed width and return it on failure, so a transient starved
   * poll never shrinks the intent — the next poll that gets through can still
   * grow the fan-out.
   */
  private concurrencyGetter(api: ReviewBoardRunApi): () => Promise<number> {
    let lastGood = FALLBACK_CONCURRENCY;
    return async () => {
      try {
        lastGood = await this.resolveConcurrency(api);
      } catch {
        // Keep the last known width; do not collapse discovered capacity.
      }
      return lastGood;
    };
  }

  private async takeLatest(
    featureId: string,
    api: ReviewBoardRunApi,
    refreshRemote = true,
  ): Promise<boolean> {
    const rec = this.record(featureId);
    rec.controller?.abort();
    rec.controller = null;
    const token = (rec.runToken += 1);
    const isStale = () => this.record(featureId).runToken !== token;
    this.update(featureId, (prev) => ({ ...prev, running: false }));

    this.setPrep(featureId, {
      active: true,
      message: refreshRemote ? 'Fetching the latest from the remote…' : 'Waiting for change evidence…',
      error: null,
    });
    try {
      if (refreshRemote) await api.pullLatestPrReview(featureId);
      if (isStale()) return false;
      this.setPrep(featureId, {
        active: true,
        message: 'Rebuilding the change graph…',
        error: null,
      });
      const startedAt = Date.now();
      const deadline = startedAt + PREP_TIMEOUT_MS;
      let recovered = false;
      for (;;) {
        if (isStale()) return false;
        const review = await api.getPrReview(featureId);
        if (isStale()) return false;
        const status = review.changeGraph.status;
        if (status === 'ready') break;
        if (status === 'failed') {
          const message = review.changeGraph.failure?.message;
          if (!recovered && api.retryPrReviewStep && (
            message === 'Background analysis cancelled during app shutdown.' ||
            message === 'Interrupted by a restart before it finished. Retry to regenerate.'
          )) {
            recovered = true;
            this.setPrep(featureId, { active: true, message: 'Resuming change evidence interrupted by app shutdown...', error: null });
            await api.retryPrReviewStep(featureId, 'changeGraph');
            continue;
          }
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
    this.update(featureId, (prev) => ({
      ...prev, prep,
      preparationTiming: prep.active
        ? (prev.prep.active ? prev.preparationTiming : { startedAt: Date.now(), finishedAt: null })
        : (prev.preparationTiming && prev.preparationTiming.finishedAt === null
          ? { ...prev.preparationTiming, finishedAt: Date.now() } : prev.preparationTiming),
    }));
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
    opts: { takeLatest?: boolean; waitForGraph?: boolean } = {},
  ): Promise<void> {
    if (this.removed.has(featureId)) return;
    this.autoScheduled.add(featureId);
    const rec = this.record(featureId);
    const token = ++rec.timingToken;
    this.bulkQueue = this.bulkQueue.filter((job) => job.featureId !== featureId);
    this.update(featureId, (prev) => ({
      ...prev, queued: false, preparationTiming: null, timing: { startedAt: Date.now(), finishedAt: null },
    }));
    try {
      await this.runAnalysis(featureId, api, opts, token);
    } finally {
      if (rec.timingToken === token) {
        this.update(featureId, (prev) => ({
          ...prev, timing: prev.timing ? { ...prev.timing, finishedAt: Date.now() } : null,
        }));
        if (!rec.controller?.signal.aborted) {
          try { await api.settleReviewBoardQueue?.(featureId); }
          catch (error) { this.setPrep(featureId, { active: false, message: '', error: messageOf(error, 'Could not save review queue status.') }); }
        }
      }
    }
  }

  private async runAnalysis(
    featureId: string,
    api: ReviewBoardRunApi,
    opts: { takeLatest?: boolean; waitForGraph?: boolean },
    timingToken: number,
  ): Promise<void> {
    if (opts.takeLatest && !(await this.takeLatest(featureId, api))) return;
    if (!opts.takeLatest && opts.waitForGraph !== false && !(await this.takeLatest(featureId, api, false))) return;
    if (this.record(featureId).timingToken !== timingToken) return;
    // Take the latest board before a full pass, so the analysis reflects the
    // current PR state rather than a stale snapshot from a previous visit.
    await this.load(featureId, api, true);
    const rec = this.record(featureId);
    if (rec.timingToken !== timingToken) return;
    const board = rec.state.board;
    if (!board || rec.state.loadError) return;
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

    const isStale = () => this.record(featureId).runToken !== token ||
      this.record(featureId).timingToken !== timingToken;

    // Server-side fan-out: one streamed request drives the whole parallel pass.
    // The backend reviews every perspective across the warm pool (reserving one
    // session for other IDE work) and streams a result per lens as it settles,
    // so concurrency scales with the pool instead of being capped at the
    // browser's ~6 connections-per-origin. Per-lens retries happen server-side.
    const applyEvent = (event: ReviewBoardPerspectiveEvent): void => {
      if (isStale()) return;
      if (event.type === 'failed' && !event.perspectiveId) {
        throw new Error(event.error || 'Review could not start. Check change evidence and retry.');
      }
      const eventId = event.type === 'analyzed' ? event.analysis.perspectiveId : event.perspectiveId;
      if (!ids.includes(eventId)) throw new Error(`Review stream returned an unknown perspective: ${eventId}`);
      if (event.type === 'analyzing') {
        this.setProgress(featureId, event.perspectiveId, {
          status: 'analyzing',
          skipReason: null,
          checked: null,
          rationale: [],
          checks: [],
          error: null,
          attempt: 1,
        });
        return;
      }
      if (event.type === 'analyzed') {
        const result = event.analysis;
        this.update(featureId, (prev) => ({
          ...prev,
          board: prev.board
            ? mergeAnalyzedPerspective(prev.board, result.perspective)
            : prev.board,
        }));
        this.setProgress(featureId, result.perspectiveId, {
          status: result.skipped ? 'skipped' : 'done',
          skipReason: result.skipReason,
          checked: result.summary,
          rationale: result.rationale,
          checks: result.checks,
          error: null,
          attempt: 0,
        });
        return;
      }
      this.setProgress(featureId, event.perspectiveId, {
        status: 'error',
        skipReason: null,
        checked: null,
        rationale: [],
        checks: [],
        error: event.error || 'This perspective could not be analysed.',
        attempt: 0,
      });
    };

    try {
      await api.analyzeReviewBoardPerspectives(
        featureId,
        applyEvent,
        controller.signal,
      );
    } catch (error) {
      // A stream-level failure (backend restart, dropped socket) isn't tied to
      // any single lens, so surface it on every perspective still waiting rather
      // than leaving them stuck on their spinners.
      if (!isStale() && !isAbort(error)) {
        const message = messageOf(
          error,
          'The review stream ended unexpectedly. Please retry.',
        );
        const progress = this.record(featureId).state.progress;
        for (const [id, p] of Object.entries(progress)) {
          if (p.status === 'pending' || p.status === 'analyzing') {
            this.setProgress(featureId, id, {
              status: 'error',
              skipReason: null,
              checked: null,
              rationale: [],
              checks: [],
              error: message,
              attempt: 0,
            });
          }
        }
      }
    }

    if (!isStale()) {
      for (const [id, progress] of Object.entries(this.record(featureId).state.progress)) {
        if (progress.status === 'pending' || progress.status === 'analyzing') {
          this.setProgress(featureId, id, {
            ...progress,
            status: 'error',
            error: controller.signal.aborted
              ? 'Review cancelled before this perspective completed.'
              : 'The review stream ended without a result for this perspective. Retry the review.',
          });
        }
      }
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
    if (this.removed.has(featureId)) return;
    if (opts.takeLatest && !(await this.takeLatest(featureId, api))) return;
    const rec = this.record(featureId);
    if (!opts.takeLatest && !rec.state.running && !(await this.takeLatest(featureId, api, false))) return;
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
      if (!isStale()) {
        this.setProgress(featureId, perspectiveId, {
          status: 'error',
          skipReason: null,
          checked: null,
          rationale: [],
          checks: [],
          error: isAbort(error) ? 'Review cancelled before this perspective completed.' :
            messageOf(error, 'This perspective could not be analysed.'),
          attempt: 0,
        });
      }
    }

    if (!isStale()) {
      this.update(featureId, (prev) => ({
        ...prev, running: Object.values(prev.progress).some((p) =>
          p.status === 'pending' || p.status === 'analyzing' || p.status === 'retrying'),
      }));
    }
  }

  /** Re-run only the perspectives that ended in an error (self-heal retry). */
  async retryFailed(
    featureId: string,
    api: ReviewBoardRunApi,
    opts: { includeIncomplete?: boolean } = {},
  ): Promise<void> {
    if (this.removed.has(featureId)) return;
    const rec = this.record(featureId);
    const failed = opts.includeIncomplete
      ? (rec.state.board?.perspectives ?? [])
        .filter((perspective) => rec.state.progress[perspective.id]?.status !== 'done')
        .map((perspective) => perspective.id)
      : Object.entries(rec.state.progress)
      .filter(([, p]) => p.status === 'error')
      .map(([id]) => id);
    if (failed.length === 0) return;
    if (!rec.state.running && !(await this.takeLatest(featureId, api, false))) return;

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

    await mapWithDynamicConcurrency(
      failed,
      this.concurrencyGetter(api),
      async (id) => {
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
        if (isStale()) return;
        this.setProgress(featureId, id, {
          status: 'error',
          skipReason: null,
          checked: null,
          rationale: [],
          checks: [],
          error: isAbort(error) ? 'Review cancelled before this perspective completed.' :
            messageOf(error, 'This perspective could not be analysed.'),
          attempt: 0,
        });
      }
      },
      { cancelled: isStale },
    );

    if (!isStale()) {
      this.update(featureId, (prev) => ({
        ...prev, running: Object.values(prev.progress).some((p) =>
          p.status === 'pending' || p.status === 'analyzing' || p.status === 'retrying'),
      }));
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
export function createReviewBoardRunStore(): ReviewBoardRunStore {
  return new ReviewBoardRunStore();
}

/** The app-wide singleton — one live run per feature, shared across mounts. */
export const reviewBoardRunStore = createReviewBoardRunStore();
