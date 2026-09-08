import { createWorkTracker } from '../kernel/work-tracker.js';
import { MetaAbortError } from './meta-runner.js';
import type { ManagedMetaOperationPhysicalOwnership, MetaOperationLease, MetaOperationOwnership, MetaOperationScope } from './meta-operation-contract.js';

interface OwnedOperation {
  scope: MetaOperationScope;
  sessions: Set<string>;
  controller: AbortController;
  active: boolean;
  confirmed: boolean;
  releasePhysical?: () => void;
}

export class MetaOperationAdmissionError extends Error {
  constructor() { super('Meta operation scope is closed'); this.name = 'MetaOperationAdmissionError'; }
}

export function createMetaOperationOwnership(deps: { physical?: ManagedMetaOperationPhysicalOwnership } = {}): MetaOperationOwnership {
  const tracker = createWorkTracker<OwnedOperation>();
  const operations = new Map<string, OwnedOperation>();
  const physical = new Map<string, OwnedOperation>();
  const features = new Set<string>();
  const sessions = new Set<string>();
  const automations = new Set<string>();
  let closed = false;

  const requirePhysical = (entry: OwnedOperation): void => {
    if (!entry.active || entry.confirmed || entry.releasePhysical) return;
    const stopped = new Promise<void>((resolve) => { entry.releasePhysical = resolve; });
    physical.set(entry.scope.operationId, entry);
    void tracker.own(entry, async () => {
      await stopped;
      physical.delete(entry.scope.operationId);
    });
  };
  const quiesce = (timeoutMs: number, matches: (entry: OwnedOperation) => boolean): Promise<boolean> => {
    for (const entry of tracker.keys()) if (matches(entry)) {
      entry.controller.abort();
      if (deps.physical) void deps.physical.quiesce(entry.scope.operationId, timeoutMs).then((proof) => {
        if (proof === 'confirmed') confirm(entry);
      }).catch(() => {});
    }
    return tracker.waitForIdle(timeoutMs, matches);
  };
  const confirm = (entry: OwnedOperation): void => {
    entry.confirmed = true;
    entry.releasePhysical?.();
    if (!entry.active) deps.physical?.forget(entry.scope.operationId);
  };
  const validateTimeout = (timeoutMs: number): void => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid meta operation quiescence timeout');
  };

  return {
    own<T>(scope: MetaOperationScope, run: (lease: MetaOperationLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (closed || features.has(scope.featureId)
        || (scope.originSessionId !== null && sessions.has(scope.originSessionId))
        || (scope.automationId !== null && automations.has(scope.automationId))
        || operations.has(scope.operationId) || physical.has(scope.operationId)) {
        return Promise.reject(new MetaOperationAdmissionError());
      }
      const entry: OwnedOperation = {
        scope: { ...scope }, sessions: new Set(scope.originSessionId === null ? [] : [scope.originSessionId]),
        controller: new AbortController(), active: true, confirmed: false,
      };
      deps.physical?.begin(scope.operationId);
      operations.set(scope.operationId, entry);
      const abort = () => entry.controller.abort();
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      return tracker.own(entry, async () => {
        let result: T;
        try {
          result = await run({
            signal: entry.controller.signal,
            abort,
            expectPhysicalOwnership: () => deps.physical?.expect(scope.operationId),
            linkSession(sessionId) {
              if (!entry.active) return;
              entry.sessions.add(sessionId);
              if (sessions.has(sessionId)) abort();
            },
            requireTerminationConfirmation: () => requirePhysical(entry),
          });
        } catch (error) {
          if (error instanceof MetaAbortError && error.termination === 'unconfirmed') requirePhysical(entry);
          throw error;
        } finally {
          if (deps.physical) {
            requirePhysical(entry);
            void deps.physical.seal(scope.operationId).then((proof) => {
              if (proof === 'confirmed') confirm(entry);
            });
          }
          entry.active = false;
          if (entry.confirmed) deps.physical?.forget(scope.operationId);
          signal?.removeEventListener('abort', abort);
          operations.delete(scope.operationId);
        }
        return result;
      });
    },
    quiesceFeature(featureId, timeoutMs) {
      validateTimeout(timeoutMs);
      features.add(featureId);
      return quiesce(timeoutMs, (entry) => entry.scope.featureId === featureId);
    },
    quiesceSession(sessionId, timeoutMs) {
      validateTimeout(timeoutMs);
      sessions.add(sessionId);
      return quiesce(timeoutMs, (entry) => entry.sessions.has(sessionId));
    },
    quiesceAutomation(automationId, timeoutMs) {
      validateTimeout(timeoutMs);
      automations.add(automationId);
      return quiesce(timeoutMs, (entry) => entry.scope.automationId === automationId);
    },
    quiesceAll(timeoutMs) {
      validateTimeout(timeoutMs);
      closed = true;
      return quiesce(timeoutMs, () => true);
    },
    confirmTermination(operationId) {
      const entry = operations.get(operationId) ?? physical.get(operationId);
      if (!entry) return;
      confirm(entry);
    },
    unconfirmed: () => [...physical.values()].map((entry) => ({ ...entry.scope, sessionIds: [...entry.sessions] })),
  };
}
