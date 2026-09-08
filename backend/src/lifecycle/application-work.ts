import { ConflictError } from '../kernel/error-types.js';
import { createWorkTracker } from '../kernel/work-tracker.js';

export interface ApplicationWorkScope {
  featureId?: string;
  sessionId?: string;
  featureIds?: readonly string[];
  sessionIds?: readonly string[];
}

export interface ApplicationWorkOwnership {
  trackScope?: ApplicationWorkScope;
  allowBlockedScope?: boolean;
}

/** Owns complete API/background callbacks, not merely their nested provider calls. */
export function createApplicationWork() {
  const work = createWorkTracker<{
    scope: ApplicationWorkScope;
    admissionScope: ApplicationWorkScope;
    allowBlockedScope: boolean;
    controller: AbortController;
  }>();
  const blockedFeatures = new Set<string>();
  const blockedSessions = new Set<string>();
  let accepting = true;
  const ids = (
    singular: string | undefined,
    plural: readonly string[] | undefined,
  ): string[] => {
    const values = new Set<string>();
    if (singular !== undefined) {
      values.add(singular);
    }
    for (const value of plural ?? []) {
      values.add(value);
    }
    return [...values];
  };
  const featureIds = (scope: ApplicationWorkScope): string[] =>
    ids(scope.featureId, scope.featureIds);
  const sessionIds = (scope: ApplicationWorkScope): string[] =>
    ids(scope.sessionId, scope.sessionIds);
  const copyScope = (scope: ApplicationWorkScope): ApplicationWorkScope => ({
    featureId: scope.featureId,
    sessionId: scope.sessionId,
    featureIds: featureIds(scope),
    sessionIds: sessionIds(scope),
  });
  const admits = (
    scope: ApplicationWorkScope,
    allowBlockedScope = false,
  ) => accepting &&
    (allowBlockedScope || (
      featureIds(scope).every((id) => !blockedFeatures.has(id)) &&
      sessionIds(scope).every((id) => !blockedSessions.has(id))
    ));
  const accepts = (scope: ApplicationWorkScope) => admits(scope);
  const blocked = () => new ConflictError('Application work is blocked by shutdown or deletion');
  const quiesce = (
    timeoutMs: number,
    matches: (entry: { scope: ApplicationWorkScope }) => boolean,
    block: () => void,
  ) => {
    block();
    const pending = work.waitForIdle(timeoutMs, matches);
    for (const entry of work.keys()) {
      if (matches(entry)) entry.controller.abort();
    }
    return pending;
  };
  return {
    get accepting(): boolean { return accepting; },
    accepts,
    own<T>(
      run: (signal: AbortSignal) => T | Promise<T>,
      scope: ApplicationWorkScope = {},
      ownership: ApplicationWorkOwnership = {},
    ): Promise<T> {
      if (!admits(scope, ownership.allowBlockedScope)) return Promise.reject(blocked());
      const trackedScope = ownership.trackScope ?? scope;
      const entry = {
        scope: copyScope(trackedScope),
        admissionScope: copyScope(scope),
        allowBlockedScope: ownership.allowBlockedScope === true,
        controller: new AbortController(),
      };
      return work.own(entry, async () => {
        if (!admits(entry.scope, entry.allowBlockedScope)) throw blocked();
        if (!admits(entry.admissionScope, entry.allowBlockedScope)) throw blocked();
        return await run(entry.controller.signal);
      });
    },
    shutdown(): void {
      accepting = false;
      for (const entry of work.keys()) entry.controller.abort();
    },
    waitForIdle: (timeoutMs: number) => work.waitForIdle(timeoutMs),
    quiesceFeature: (id: string, timeoutMs: number) =>
      quiesce(
        timeoutMs,
        (entry) => featureIds(entry.scope).includes(id),
        () => { blockedFeatures.add(id); },
      ),
    quiesceSession: (id: string, timeoutMs: number) =>
      quiesce(
        timeoutMs,
        (entry) => sessionIds(entry.scope).includes(id),
        () => { blockedSessions.add(id); },
      ),
  };
}
