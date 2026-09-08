import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type {
  UsageCapturePage,
  UsageCaptureRepo,
} from '../usage/usage-capture-contract.js';

export interface CaptureRecoveryScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultScheduler: CaptureRecoveryScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface StoppedCaptureRecoveryTailer {
  /** One synchronous, bounded durable reconciliation attempt for this session. */
  finalize(): unknown;
  stop(): void;
}

export interface StoppedCaptureRecoveryLogger {
  error(message: string, error: unknown): void;
}

export interface StoppedCaptureRecoveryDeps {
  captures: Pick<UsageCaptureRepo, 'listUnfinishedPage'>;
  sessions: Pick<SessionRepo, 'get'>;
  makeTailer(session: Session): StoppedCaptureRecoveryTailer;
  hasLiveTailer(sessionId: string): boolean;
  pageSize: number;
  intervalMs: number;
  logger: StoppedCaptureRecoveryLogger;
  scheduler?: CaptureRecoveryScheduler;
}

export interface StoppedCaptureRecovery {
  start(): void;
  stop(): void;
  finalize(): void;
}

/**
 * Continues bounded usage-capture repair for ended sessions. It advances the
 * durable replay/source cursors with each session's resumable bounded
 * finalizer, so large retained ledgers resume where they left off across
 * restarts instead of resetting to the first prefix on every startup.
 */
export function createStoppedCaptureRecovery(
  deps: StoppedCaptureRecoveryDeps,
): StoppedCaptureRecovery {
  if (!Number.isSafeInteger(deps.pageSize) || deps.pageSize < 1 || deps.pageSize > 1000) {
    throw new RangeError('Recovery page size must be an integer between 1 and 1000');
  }
  if (!Number.isSafeInteger(deps.intervalMs) || deps.intervalMs < 1 || deps.intervalMs > 2_147_483_647) {
    throw new RangeError('Recovery interval must be a positive timer-safe integer');
  }
  const scheduler = deps.scheduler ?? defaultScheduler;
  let interval: { handle: unknown } | undefined;
  let cursor: string | null = null;
  let running = false;
  let active = false;
  let generation = 0;

  const runOnce = (owner: number): void => {
    if (running) {
      return;
    }
    running = true;
    try {
      let page: UsageCapturePage;
      try {
        page = deps.captures.listUnfinishedPage(cursor, deps.pageSize);
      } catch (error) {
        deps.logger.error('Usage recovery page read failed', error);
        return;
      }
      for (const capture of page.items) {
        if (owner !== generation) {
          return;
        }
        cursor = capture.sessionId;
        let tailer: StoppedCaptureRecoveryTailer | undefined;
        try {
          const session = deps.sessions.get(capture.sessionId);
          if (!session || deps.hasLiveTailer(session.id) || owner !== generation) {
            continue;
          }
          tailer = deps.makeTailer(session);
          // Injected construction can stop recovery or transfer/delete session ownership.
          if (owner !== generation || !deps.sessions.get(session.id) ||
            deps.hasLiveTailer(session.id) || owner !== generation) {
            continue;
          }
          tailer.finalize();
        } catch (error) {
          deps.logger.error('Recovered usage capture failed', error);
        } finally {
          if (tailer) {
            try {
              tailer.stop();
            } catch (error) {
              deps.logger.error('Recovered usage cleanup failed', error);
            }
          }
        }
      }
      if (owner === generation) {
        cursor = page.nextCursor;
      }
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (active) {
        return;
      }
      active = true;
      const owner = ++generation;
      runOnce(owner);
      if (!active || owner !== generation) {
        return;
      }
      try {
        const handle = scheduler.setInterval(() => {
          if (active && owner === generation) {
            runOnce(owner);
          }
        }, deps.intervalMs);
        if (active && owner === generation) {
          interval = { handle };
        } else {
          scheduler.clearInterval(handle);
        }
      } catch (error) {
        if (owner === generation) {
          active = false;
          generation++;
        }
        throw error;
      }
    },
    stop() {
      active = false;
      generation++;
      const previous = interval;
      interval = undefined;
      if (previous) {
        scheduler.clearInterval(previous.handle);
      }
    },
    finalize() {
      runOnce(generation);
    },
  };
}
