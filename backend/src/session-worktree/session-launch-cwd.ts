import type { Session } from '../session/session-contract.js';
import type { SessionWorktreeTarget } from './session-ref-resolver.js';

/** Coalesces reconnects while retaining any previously recorded session copy. */
export function createSessionLaunchCwdResolver(deps: {
  getSession(id: string): Session | null;
  pathExists(path: string): Promise<boolean>;
  resolveTarget(featureId: string): Promise<SessionWorktreeTarget | null>;
  fallbackCwd(featureId: string): string | undefined;
  prepare(session: Session, target: SessionWorktreeTarget, report: (message: string) => void): Promise<string>;
  own?: (session: Session, prepare: () => Promise<string | undefined>) => Promise<string | undefined>;
}) {
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
        const target = await deps.resolveTarget(latest.featureId);
        if (!target) return deps.fallbackCwd(latest.featureId);
        return deps.prepare(latest, target, (message) => {
          current.message = message;
          for (const listener of current.listeners) listener(message);
        });
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
