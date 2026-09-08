import type { SessionKind } from '../provider/provider-contract.js';
import type { UsageRecorder } from './usage-recorder.js';
import type { UsageCaptureRead, UsageCaptureRepo, UsageCaptureState } from './usage-capture-contract.js';
import { UsageCaptureIdentityError } from './usage-capture-contract.js';

export interface TailScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultScheduler: TailScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface CliUsageTailerDeps {
  sessionId: string;
  sourceId: string;
  read: (cursor: string | null, limit: number) => UsageCaptureRead;
  recorder: Pick<UsageRecorder, 'reconcile'>;
  captures: UsageCaptureRepo;
  kind: SessionKind;
  intervalMs: number;
  pageSize: number;
  finalDrainPages: number;
  scheduler?: TailScheduler;
}

export interface CliUsageTailer {
  start(): void;
  stop(): void;
  /** One bounded page. Failures leave the checkpoint retryable. */
  drain(): UsageCaptureState;
  /** Continues a durable bounded reconciliation epoch; EOF alone is not finality. */
  finalize(): UsageCaptureState;
  status(): UsageCaptureState;
}

export function createCliUsageTailer(deps: CliUsageTailerDeps): CliUsageTailer {
  const scheduler = deps.scheduler ?? defaultScheduler;
  let state: UsageCaptureState = deps.captures.get(deps.sessionId) ?? {
    sessionId: deps.sessionId, sourceId: deps.sourceId, cursor: null, replayCursor: null,
    finalScan: false, replayClean: false, sourceDone: false, replayDone: false,
    status: 'pending', reason: 'capture-not-started',
  };
  let handle: unknown;
  let running = false;
  let draining = false;

  const save = (next: UsageCaptureState): void => {
    deps.captures.save(next);
    state = next;
  };
  const drain = (): UsageCaptureState => {
    if (draining) return { ...state };
    draining = true;
    let stage = 'checkpoint-failed';
    try {
      if (state.reason === 'capture-in-progress') {
        // A prior pass died after checkpointing "in progress" but before it
        // durably proved sink convergence. Re-run both halves rather than let
        // stale proof markers suppress replay after a rollback or crash.
        state = {
          ...state,
          finalScan: false,
          replayClean: false,
          sourceDone: false,
          replayDone: false,
        };
      } else if (state.sourceDone && state.replayDone) {
        state = { ...state, sourceDone: false, replayDone: false, finalScan: false, replayClean: false };
      } else if (!state.sourceDone && state.replayDone && state.status !== 'pending') {
        // An unavailable source must not permanently disable sink repair.
        state = { ...state, replayDone: false, replayClean: false };
      }
      // Persist pending BEFORE touching the source, including on a fresh session.
      save({ ...state, status: 'pending', reason: 'capture-in-progress' });
      let replayIssue = false;
      if (!state.replayDone) {
        stage = 'replay-read-failed';
        const replay = deps.captures.listReplay(deps.sessionId, state.replayCursor ?? null, deps.pageSize + 1);
        const replayPage = replay.slice(0, deps.pageSize);
        for (const row of replayPage) {
          if (row.event === null) {
            replayIssue = true;
            continue;
          }
          stage = 'usage-recording-failed';
          deps.recorder.reconcile(row.event, deps.kind);
          const fingerprint = JSON.stringify(row.event);
          if (row.fingerprint !== fingerprint) {
            stage = 'identity-checkpoint-failed';
            deps.captures.acknowledge(deps.sessionId, row.sourceKey, fingerprint);
          }
        }
        const replayClean = !replayIssue && (state.replayCursor == null || state.replayClean === true);
        const replayCursor = replay.length > deps.pageSize ? replayPage[replayPage.length - 1].turnIndex : null;
        stage = 'checkpoint-failed';
        save({
          ...state, replayCursor, replayClean, replayDone: replayCursor === null && replayClean,
          sourceDone: replayIssue ? false : state.sourceDone,
          finalScan: replayIssue ? false : state.finalScan,
        });
      }
      if (state.sourceDone) {
        const complete = state.replayDone && state.finalScan;
        save({ ...state, status: complete ? 'complete' : 'pending', reason: complete ? null : 'source-finality-unknown' });
        return { ...state };
      }
      stage = 'source-read-failed';
      const result = deps.read(state.cursor, deps.pageSize);
      stage = 'checkpoint-failed';
      if (result.sourceId !== state.sourceId) {
        save({ ...state, finalScan: false, status: 'unsupported', reason: 'source-identity-changed' });
      } else if (result.status !== 'ready') {
        save({ ...state, finalScan: false, status: result.status, reason: result.reason });
      } else {
        // Retain every observed payload before attempting any sink write: a
        // failed first insert must not lose later rows if the provider prunes.
        const staged = result.rows.map((row) => {
          stage = 'identity-reservation-failed';
          if (row.event.sessionId !== deps.sessionId) throw new UsageCaptureIdentityError('source-session-mismatch');
          const identity = deps.captures.reserve(deps.sessionId, row.sourceKey, row.event);
          return { ...identity, sourceKey: row.sourceKey };
        });
        for (const row of staged) {
          stage = 'usage-recording-failed';
          deps.recorder.reconcile(row.event, deps.kind);
          const fingerprint = JSON.stringify(row.event);
          if (row.fingerprint !== fingerprint) {
            stage = 'identity-checkpoint-failed';
            deps.captures.acknowledge(deps.sessionId, row.sourceKey, fingerprint);
          }
        }
        stage = 'checkpoint-failed';
        const finalScan = result.final && !result.issue && (state.cursor === null || state.finalScan === true);
        const sourceDone = result.nextCursor === null && !result.issue;
        const complete = finalScan && sourceDone && state.replayDone;
        save({
          ...state, cursor: result.nextCursor, finalScan, sourceDone,
          status: result.issue?.status ?? (replayIssue ? 'retrying' : complete ? 'complete' : 'pending'),
          reason: result.issue?.reason ?? (replayIssue ? 'capture-payload-unavailable' : complete ? null : result.nextCursor === null ? 'source-finality-unknown' : 'backfill-in-progress'),
        });
      }
    } catch (error) {
      state = {
        ...state, finalScan: false, replayClean: false, sourceDone: false, replayDone: false,
        status: error instanceof UsageCaptureIdentityError ? 'unsupported' : 'retrying',
        reason: error instanceof UsageCaptureIdentityError ? error.reason : stage,
      };
      // A failing database cannot persist its own failure. The previously saved
      // pending state and reserved identities remain the recovery authority.
      try { deps.captures.save(state); } catch { state.reason = 'checkpoint-unavailable'; }
    } finally {
      draining = false;
    }
    return { ...state };
  };

  return {
    start() {
      if (running) return;
      running = true;
      drain();
      if (running) handle = scheduler.setInterval(drain, deps.intervalMs);
    },
    stop() {
      running = false;
      if (handle !== undefined) {
        scheduler.clearInterval(handle);
        handle = undefined;
      }
    },
    drain,
    finalize() {
      for (let page = 0; page < deps.finalDrainPages; page += 1) {
        const before = state;
        const result = drain();
        if (result.reason === 'checkpoint-unavailable') break;
        if (result.sourceDone && result.replayDone) break;
        if (result.status !== 'pending' && result.replayDone) break;
        if (result.cursor === before.cursor && result.replayCursor === before.replayCursor
          && result.sourceDone === before.sourceDone && result.replayDone === before.replayDone) break;
      }
      return { ...state };
    },
    status: () => ({ ...state }),
  };
}
