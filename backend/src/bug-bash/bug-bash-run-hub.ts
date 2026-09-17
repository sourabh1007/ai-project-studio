/**
 * Owns Bug Bash generate/run passes independently of any HTTP request.
 *
 * A pass is kicked off once and then lives here in the background: its streamed
 * activity is buffered so a window that reconnects (or a second window) can
 * replay everything so far and keep tailing live events. A client disconnecting
 * only detaches its listener — it never cancels the underlying metasession, so
 * switching windows can't stop generation or a run.
 */
import type {
  BugBashActivity,
  BugBashAgent,
  BugBashRun,
  BugBashService,
} from './bug-bash-contract.js';

/** One NDJSON event a pass streams to attached listeners. */
export type BugBashStreamEvent =
  | ({ type: 'activity' } & Omit<BugBashActivity, 'runId'>)
  | { type: 'agent'; agent: BugBashAgent }
  | { type: 'done'; run: BugBashRun }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };

export type BugBashStreamListener = (event: BugBashStreamEvent) => void;

export interface BugBashRunHub {
  /** Start (or no-op if already running) a scenario-generation pass. */
  startGenerate(attachmentId: string): void;
  /** Start (or no-op if already running) a scenario-execution pass. */
  startRun(attachmentId: string): void;
  /**
   * Cancel the attachment's in-flight pass: aborts the underlying metasession
   * (terminating any attached agent process), emits a terminal `cancelled`
   * event to every attached listener, and clears the run so a fresh pass can
   * start. Returns whether a live pass was cancelled.
   */
  cancel(attachmentId: string): boolean;
  /**
   * Attach a listener to the attachment's current pass: replays every buffered
   * event, then forwards live ones. Returns an unsubscribe function that only
   * detaches the listener — the pass keeps going. When no pass exists the
   * listener receives nothing and the unsubscribe is a no-op.
   */
  attach(attachmentId: string, listener: BugBashStreamListener): () => void;
  /** Whether a pass is currently live (running or replayable). */
  isLive(attachmentId: string): boolean;
}

interface LiveRun {
  events: BugBashStreamEvent[];
  listeners: Set<BugBashStreamListener>;
  settled: boolean;
  controller: AbortController;
}

export function createBugBashRunHub(deps: {
  service: BugBashService;
}): BugBashRunHub {
  const runs = new Map<string, LiveRun>();

  function emit(live: LiveRun, event: BugBashStreamEvent): void {
    live.events.push(event);
    for (const listener of live.listeners) {
      listener(event);
    }
  }

  function begin(
    attachmentId: string,
    run: (
      sink: {
        activity(activity: Omit<BugBashActivity, 'runId'>): void;
        agent(agent: BugBashAgent): void;
        done(run: BugBashRun): void;
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
      activity: (activity: Omit<BugBashActivity, 'runId'>) =>
        emit(live, { type: 'activity', ...activity }),
      agent: (agent: BugBashAgent) => emit(live, { type: 'agent', agent }),
      done: (settledRun: BugBashRun) =>
        emit(live, { type: 'done', run: settledRun }),
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
    startGenerate: (attachmentId) =>
      begin(attachmentId, (sink, signal) =>
        deps.service.generate(attachmentId, signal, sink),
      ),
    startRun: (attachmentId) =>
      begin(attachmentId, (sink, signal) =>
        deps.service.run(attachmentId, sink, signal),
      ),
    cancel: (attachmentId) => {
      const live = runs.get(attachmentId);
      if (!live || live.settled) {
        return false;
      }
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
