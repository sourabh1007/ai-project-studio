/**
 * Owns New Task planning/implementation runs independently of any HTTP request.
 *
 * A run is kicked off once and then lives here in the background: its streamed
 * activity is buffered so a window that reconnects (or a second window) can
 * replay everything so far and keep tailing live events. Crucially, a client
 * disconnecting only detaches its listener — it never cancels the underlying
 * metasession, so switching windows can't stop planning or implementation.
 */
import type {
  NewTaskActivity,
  NewTaskAgent,
  NewTaskFileChange,
  NewTaskPlanOptions,
  NewTaskRun,
  NewTaskService,
} from './new-task-contract.js';

/** One NDJSON event a run streams to attached listeners. */
export type NewTaskStreamEvent =
  | ({ type: 'activity' } & Omit<NewTaskActivity, 'runId'>)
  | { type: 'agent'; agent: NewTaskAgent }
  | { type: 'done'; run: NewTaskRun; files?: NewTaskFileChange[] }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };

export type NewTaskStreamListener = (event: NewTaskStreamEvent) => void;

export interface NewTaskRunHub {
  /** Start (or no-op if already running) a planning pass for the attachment. */
  startPlan(attachmentId: string, options?: NewTaskPlanOptions): void;
  /** Start (or no-op if already running) an implementation pass. */
  startImplement(attachmentId: string): void;
  /**
   * Cancel the attachment's in-flight run: aborts the underlying metasession
   * (which terminates any attached agent process), emits a terminal `cancelled`
   * event to every attached listener so their stream ends at once, and clears
   * the run so a fresh pass can start. Returns whether a live run was cancelled.
   */
  cancel(attachmentId: string): boolean;
  /**
   * Attach a listener to the attachment's current run: replays every buffered
   * event, then forwards live ones. Returns an unsubscribe function that only
   * detaches the listener — the run keeps going. When no run exists the listener
   * receives nothing and the unsubscribe is a no-op.
   */
  attach(attachmentId: string, listener: NewTaskStreamListener): () => void;
  /**
   * Whether a run is currently live (running or replayable) for the attachment.
   * A reconnecting stream uses this to end at once when nothing is in flight —
   * e.g. after the app restarted mid-run — so the UI falls back to its
   * "interrupted — resume" affordance instead of hanging on an open socket.
   */
  isLive(attachmentId: string): boolean;
}

interface LiveRun {
  events: NewTaskStreamEvent[];
  listeners: Set<NewTaskStreamListener>;
  settled: boolean;
  controller: AbortController;
}

export function createNewTaskRunHub(deps: {
  service: NewTaskService;
}): NewTaskRunHub {
  const runs = new Map<string, LiveRun>();

  function emit(live: LiveRun, event: NewTaskStreamEvent): void {
    live.events.push(event);
    for (const listener of live.listeners) {
      listener(event);
    }
  }

  function begin(
    attachmentId: string,
    run: (
      sink: {
        activity(activity: Omit<NewTaskActivity, 'runId'>): void;
        agent(agent: NewTaskAgent): void;
        done(run: NewTaskRun, files?: NewTaskFileChange[]): void;
        failed(error: string): void;
      },
      signal: AbortSignal,
    ) => Promise<unknown>,
  ): void {
    const existing = runs.get(attachmentId);
    if (existing && !existing.settled) {
      // A pass is already in flight for this attachment; do not start another.
      return;
    }
    const live: LiveRun = {
      events: [],
      listeners: new Set(),
      settled: false,
      controller: new AbortController(),
    };
    runs.set(attachmentId, live);
    const sink = {
      activity: (activity: Omit<NewTaskActivity, 'runId'>) =>
        emit(live, { type: 'activity', ...activity }),
      agent: (agent: NewTaskAgent) => emit(live, { type: 'agent', agent }),
      done: (settledRun: NewTaskRun, files?: NewTaskFileChange[]) =>
        emit(live, { type: 'done', run: settledRun, files }),
      failed: (error: string) => emit(live, { type: 'failed', error }),
    };
    run(sink, live.controller.signal)
      .catch((error: unknown) =>
        emit(live, {
          type: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        live.settled = true;
      });
  }

  return {
    startPlan: (attachmentId, options) =>
      begin(attachmentId, (sink, signal) =>
        deps.service.plan(attachmentId, signal, sink, options),
      ),
    startImplement: (attachmentId) =>
      begin(attachmentId, (sink, signal) =>
        deps.service.implement(attachmentId, sink, signal),
      ),
    cancel: (attachmentId) => {
      const live = runs.get(attachmentId);
      if (!live || live.settled) {
        return false;
      }
      // Abort first so any attached agent process is torn down, then emit a
      // terminal event so listeners' streams end immediately, and drop the run
      // so the next plan/implement starts clean.
      live.controller.abort();
      emit(live, { type: 'cancelled' });
      live.settled = true;
      runs.delete(attachmentId);
      return true;
    },
    attach: (attachmentId, listener) => {
      const live = runs.get(attachmentId);
      if (!live) {
        return () => {};
      }
      for (const event of live.events) {
        listener(event);
      }
      live.listeners.add(listener);
      return () => {
        live.listeners.delete(listener);
      };
    },
    isLive: (attachmentId) => runs.has(attachmentId),
  };
}
