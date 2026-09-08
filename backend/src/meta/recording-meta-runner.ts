import type { Clock } from '../kernel/clock.js';
import { MetaAbortError, type MetaRunner, type MetaUsageSnapshot } from './meta-runner.js';
import type {
  MetaOperation, MetaOperationOwnership, MetaOperationRepo, MetaOperationRequest,
  MetaOperationStart, MetaOperationUsageState, RecordedMetaRunResult,
} from './meta-operation-contract.js';
import type { PersistedMetaUsage } from './meta-usage-contract.js';

export interface RecordingMetaRunnerDeps {
  base: MetaRunner;
  operations: MetaOperationRepo;
  ownership: MetaOperationOwnership;
  clock: Clock;
  newOperationId(): string;
  resolveIdentity(request: MetaOperationRequest): { providerId: string; requestedModel: string };
}

export class MetaOperationPersistenceError extends Error {
  constructor(readonly operationId: string, cause: unknown) {
    super('Meta operation persistence failed; execution was not retried', { cause });
    this.name = 'MetaOperationPersistenceError';
  }
}

export class MetaOperationRemovedError extends Error {
  constructor(readonly operationId: string) {
    super('Meta operation was removed before completion');
    this.name = 'MetaOperationRemovedError';
  }
}

function known(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageSnapshot(value: MetaUsageSnapshot | null | undefined): {
  usage: MetaUsageSnapshot | null; state: MetaOperationUsageState;
} {
  if (!value) return { usage: null, state: 'unknown' };
  const usage = {
    inputTokens: known(value.inputTokens), outputTokens: known(value.outputTokens),
    nanoAiu: known(value.nanoAiu), credits: known(value.credits),
  };
  const count = Object.values(usage).filter((item) => item !== null).length;
  return { usage, state: count === 0 ? 'unknown' : count === 4 ? 'recorded' : 'partial' };
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Meta operation failed';
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}

/** Records every routed request before dispatch, and full output before success. */
export function createRecordingMetaRunner(deps: RecordingMetaRunnerDeps): MetaRunner {
  const runDetailed = (request: MetaOperationRequest): Promise<RecordedMetaRunResult> => {
    const operationId = deps.newOperationId();
    const scope = {
      operationId, featureId: request.featureId,
      automationId: request.automationId ?? null, originSessionId: request.originSessionId ?? null,
    };
    return deps.ownership.own(scope, async (lease) => {
      const now = deps.clock.isoNow();
      let operation: MetaOperation = {
        ...scope, providerId: null, requestedModel: null, resolvedModel: null,
        sessionId: null, providerSessionId: null, sessionIds: [], transport: 'unknown',
        state: 'pending', outcome: 'not-dispatched', purpose: request.purpose ?? null,
        label: request.label ?? null, resultText: null, errorMessage: null,
        usageState: 'unknown', usage: null, createdAt: now, updatedAt: now,
        startedAt: null, finishedAt: null,
      };
      let created = false;
      let finished = false;
      let startFailure: MetaOperationPersistenceError | null = null;
      let completed: RecordedMetaRunResult;
      const update = (): void => {
        if (!deps.operations.update(operation)) throw new MetaOperationRemovedError(operationId);
      };
      try {
        deps.operations.create(operation);
        created = true;
        if (lease.signal.aborted) {
          throw new MetaAbortError({ kind: 'aborted', termination: 'not-started' });
        }
        const identity = deps.resolveIdentity(request);
        if (!identity.providerId || !identity.requestedModel) throw new Error('Meta operation request identity is unavailable');
        let providerId = identity.providerId;
        operation = {
          ...operation, ...identity, state: 'running', outcome: 'unknown',
          startedAt: deps.clock.isoNow(), updatedAt: deps.clock.isoNow(),
        };
        update();
        lease.expectPhysicalOwnership();
        const result = await deps.base.runDetailed({
          ...request, operationId, providerId: identity.providerId, model: identity.requestedModel, signal: lease.signal,
          onStart(sessionId: string, attribution?: MetaOperationStart) {
            if (finished || startFailure) return;
            try {
              lease.linkSession(sessionId);
              const sameSession = operation.sessionId === sessionId;
              providerId = attribution?.providerId ?? (sameSession ? providerId : identity.providerId);
              operation = {
                ...operation, sessionId, sessionIds: [...new Set([...operation.sessionIds, sessionId])],
                providerId,
                providerSessionId: attribution?.providerSessionId ?? (sameSession ? operation.providerSessionId : null),
                transport: attribution?.transport ?? (sameSession ? operation.transport : 'unknown'),
                updatedAt: deps.clock.isoNow(),
              };
              update();
              if (!lease.signal.aborted) request.onStart?.(sessionId, attribution);
            } catch (error) {
              startFailure = new MetaOperationPersistenceError(operationId, error);
              lease.abort();
            }
          },
        } satisfies MetaOperationRequest);
        if (typeof result.text !== 'string') throw new Error('Meta operation result text is unavailable');
        const snapshot = usageSnapshot(result.usage);
        lease.linkSession(result.sessionId);
        const sameSession = operation.sessionId === result.sessionId;
        providerId = result.providerId ?? (sameSession ? providerId : identity.providerId);
        operation = {
          ...operation, sessionId: result.sessionId, sessionIds: [...new Set([...operation.sessionIds, result.sessionId])],
          providerId,
          resolvedModel: result.resolvedModel ?? null,
          providerSessionId: result.providerSessionId ?? (sameSession ? operation.providerSessionId : null),
          transport: result.transport ?? 'unknown', resultText: result.text, outcome: 'returned',
          usage: snapshot.usage, usageState: snapshot.state, updatedAt: deps.clock.isoNow(),
        };
        if (startFailure) throw startFailure;
        if (lease.signal.aborted) throw new Error('Meta operation cancelled after provider returned');
        const warmUsage: PersistedMetaUsage | null = operation.transport === 'warm-acp' ? {
          sessionId: result.sessionId, featureId: operation.featureId,
          providerId, requestedModel: identity.requestedModel,
          resolvedModel: operation.resolvedModel, transport: 'warm-acp',
          providerSessionId: operation.providerSessionId, purpose: operation.purpose, label: operation.label,
          inputTokens: snapshot.usage?.inputTokens ?? null, outputTokens: snapshot.usage?.outputTokens ?? null,
          nanoAiu: snapshot.usage?.nanoAiu ?? null, credits: snapshot.usage?.credits ?? null,
          capturedAt: deps.clock.isoNow(),
        } : null;
        operation = { ...operation, state: 'completed', finishedAt: deps.clock.isoNow() };
        try {
          if (!deps.operations.complete(operation, warmUsage)) throw new MetaOperationRemovedError(operationId);
        } catch (error) {
          throw error instanceof MetaOperationRemovedError ? error : new MetaOperationPersistenceError(operationId, error);
        }
        completed = { ...result, operationId };
      } catch (error) {
        if (error instanceof MetaAbortError && error.termination === 'unconfirmed') lease.requireTerminationConfirmation();
        const failure = startFailure ?? error;
        if (created) {
          operation = {
            ...operation,
            state: error instanceof MetaAbortError || lease.signal.aborted ? 'interrupted' : 'failed',
            outcome: operation.outcome === 'returned' ? 'returned'
              : error instanceof MetaAbortError && error.termination === 'not-started' ? 'not-dispatched' : operation.outcome,
            errorMessage: errorMessage(failure), updatedAt: deps.clock.isoNow(), finishedAt: deps.clock.isoNow(),
          };
          try { update(); } catch (saveError) {
            throw saveError instanceof MetaOperationRemovedError ? saveError
              : new MetaOperationPersistenceError(operationId, new AggregateError([failure, saveError]));
          }
        }
        throw created ? failure : new MetaOperationPersistenceError(operationId, failure);
      } finally {
        finished = true;
      }
      return completed;
    }, request.signal);
  };
  return { runDetailed, run: async (request) => (await runDetailed(request)).text };
}
