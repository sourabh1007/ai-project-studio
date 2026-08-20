/**
 * Persistent, per-feature store for the Review Board's AI analysis run.
 *
 * The analysis is **sequential and self-healing**: perspectives are reviewed
 * one at a time, each request is retried with backoff before it is surfaced as
 * an error, and the whole run keeps going even when the Review Board page
 * unmounts (the reviewer switched tabs/windows). The page is a thin subscriber
 * over this store via `useSyncExternalStore`, so navigating away and back shows
 * the live progress instead of restarting from scratch.
 *
 * All pure decision logic lives in `../../lib/review-board-progress.ts` (which
 * the UI coverage gate exercises); this module is the thin, stateful IO shell
 * that drives it — the same ports-and-adapters split the backend uses.
 */

import type {
  PerspectiveAnalysis,
  PerspectiveCheck,
  RationalePoint,
  ReviewBoard,
} from '../../lib/types.js';
import { ApiError } from '../../lib/api.js';
import {
  mapWithConcurrency,
  mergeAnalyzedPerspective,
  runWithRetry,
  RetryCancelledError,
} from '../../lib/review-board-progress.js';

/** How many perspectives are analysed at once — strictly one, in order. */
const ANALYZE_CONCURRENCY = 1;
/** Attempts (initial + retries) before a perspective is marked failed. */
const MAX_ATTEMPTS = 3;
/** Backoff before the retry that follows a failed attempt (grows per attempt). */
const RETRY_BACKOFF_MS = 1_500;

/** The subset of the API client the store drives. */
export interface ReviewBoardRunApi {
  getReviewBoard(featureId: string): Promise<ReviewBoard>;
  analyzeReviewBoardPerspective(
    featureId: string,
    perspectiveId: string,
    signal?: AbortSignal,
  ): Promise<PerspectiveAnalysis>;
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
}

export interface ReviewBoardRunState {
  board: ReviewBoard | null;
  loading: boolean;
  loadError: string | null;
  analyzed: boolean;
  running: boolean;
  progress: Record<string, PerspectiveProgress>;
}

const EMPTY_STATE: ReviewBoardRunState = {
  board: null,
  loading: false,
  loadError: null,
  analyzed: false,
  running: false,
  progress: {},
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
      rec = { state: EMPTY_STATE, runToken: 0, controller: null };
      this.records.set(featureId, rec);
    }
    return rec;
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
      // Keep the current board visible until the reload lands.
      board: rec.state.board,
    };
    this.emit(featureId);
    void this.load(featureId, api, true);
  }

  /**
   * Run the sequential, self-healing analysis over every perspective. Safe to
   * call repeatedly — a fresh call supersedes any prior run (aborting it) so the
   * "Analyze with AI" button always starts a clean pass.
   */
  async analyze(featureId: string, api: ReviewBoardRunApi): Promise<void> {
    const rec = this.record(featureId);
    const board = rec.state.board;
    if (!board) return;
    const ids = board.perspectives.map((p) => p.id);

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

    await mapWithConcurrency(ids, ANALYZE_CONCURRENCY, async (id) => {
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

    await mapWithConcurrency(failed, ANALYZE_CONCURRENCY, async (id) => {
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
}

/** The app-wide singleton — one live run per feature, shared across mounts. */
export const reviewBoardRunStore = new ReviewBoardRunStore();
