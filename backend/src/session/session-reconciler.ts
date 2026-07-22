import type { Clock } from '../kernel/clock.js';
import type { SessionRepo } from './session-repo-port.js';
import { isTerminal } from './session-state-machine.js';

/**
 * Reconciles sessions left in a non-terminal state by a previous run. When the
 * app exits, any live CLI processes die but their session rows stay `created`
 * or `running`, which then falsely count as "active" and make time-spent grow
 * forever. On startup we transition every such orphan to `cancelled` and stamp
 * an end time so counts and durations reflect reality.
 */
export interface SessionReconciler {
  /** Reconciles orphaned sessions, returning how many were updated. */
  reconcileOrphans(): number;
}

export interface SessionReconcilerDeps {
  sessions: SessionRepo;
  clock: Clock;
}

export function createSessionReconciler(
  deps: SessionReconcilerDeps,
): SessionReconciler {
  const { sessions, clock } = deps;
  return {
    reconcileOrphans() {
      const endedAt = clock.isoNow();
      let reconciled = 0;
      for (const session of sessions.listAll()) {
        if (isTerminal(session.status)) {
          continue;
        }
        sessions.save({
          ...session,
          status: 'cancelled',
          endedAt: session.endedAt ?? endedAt,
        });
        reconciled += 1;
      }
      return reconciled;
    },
  };
}
