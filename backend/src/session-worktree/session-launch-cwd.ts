import type { Session } from '../session/session-contract.js';
import type { SavedSessionCheckout, SelectSessionWorktree, SessionWorktreeTarget } from './session-ref-resolver.js';
import type { ConfirmCheckoutRecovery } from './checkout-recovery.js';
import { ValidationError } from '../kernel/error-types.js';

export interface SessionLaunchCwdDeps {
  getSession(id: string): Session | null;
  pathExists(path: string): Promise<boolean>;
  resolveTarget(featureId: string, select?: SelectSessionWorktree, saved?: SavedSessionCheckout): Promise<SessionWorktreeTarget | null>;
  bindSession(id: string, worktree: { path: string; branch: string }): void;
  fallbackCwd(featureId: string): string | undefined;
  prepare(session: Session, target: SessionWorktreeTarget, report: (message: string) => void, confirm?: ConfirmCheckoutRecovery): Promise<string>;
  own?: (session: Session, prepare: () => Promise<string | undefined>) => Promise<string | undefined>;
}

/** Coalesces reconnects while retaining any previously recorded session copy. */
export function createSessionLaunchCwdResolver(deps: SessionLaunchCwdDeps) {
  interface Flight {
    message: string;
    listeners: Set<(message: string) => void>;
    result: Promise<string | undefined>;
  }
  const flights = new Map<string, Flight>();
  return async (
    session: Session,
    report: (message: string) => void = () => {},
    signal?: AbortSignal,
    confirm?: ConfirmCheckoutRecovery,
    select?: SelectSessionWorktree,
  ): Promise<string | undefined> => {
    signal?.throwIfAborted();
    let flight = flights.get(session.id);
    if (!flight) {
      const current: Flight = {
        message: 'Checking the session checkout…',
        listeners: new Set(),
        result: Promise.resolve(undefined),
      };
      flights.set(session.id, current);
      const prepare = async () => {
        const latest = deps.getSession(session.id) ?? session;
        if (latest.worktreePath && await deps.pathExists(latest.worktreePath)) {
          return latest.worktreePath;
        }
        const target = await deps.resolveTarget(latest.featureId, select, latest.worktreePath
          ? { path: latest.worktreePath, ...(latest.branch ? { ref: latest.branch } : {}) } : undefined);
        if (!target) return deps.fallbackCwd(latest.featureId);
        const prepared = await deps.prepare(latest, latest.worktreePath && latest.branch
          ? { ...target, checkoutPath: latest.worktreePath, ref: latest.branch } : target, (message) => {
          current.message = message;
          for (const listener of current.listeners) listener(message);
        }, confirm);
        if (target.bindSession && !latest.worktreePath) {
          const currentSession = deps.getSession(session.id);
          if (!currentSession || currentSession.featureId !== latest.featureId || currentSession.worktreePath) {
            throw new ValidationError('The session changed during worktree selection. Reconnect to check its checkout.');
          }
          deps.bindSession(session.id, { path: prepared, branch: target.ref });
        }
        return prepared;
      };
      current.result = (async () => deps.own ? deps.own(session, prepare) : prepare())()
        .finally(() => flights.delete(session.id));
      flight = current;
    }
    const shared = flight;
    return new Promise((resolve, reject) => {
      const notify = (message: string) => {
        try { report(message); } catch { /* a disconnected view must not fail checkout */ }
      };
      const cleanup = () => {
        shared.listeners.delete(notify);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); reject(signal!.reason); };
      shared.listeners.add(notify);
      signal?.addEventListener('abort', abort, { once: true });
      notify(shared.message);
      shared.result.then(
        (path) => { cleanup(); resolve(path); },
        (error) => { cleanup(); reject(error); },
      );
    });
  };
}
