import type { Clock } from '../kernel/clock.js';
import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { Session, StartSessionRequest } from '../session/session-contract.js';
import type { MetaOperation, MetaOperationRepo } from './meta-operation-contract.js';

export interface RecordingSessionLauncherDeps {
  base: SessionLauncher;
  operations: Pick<MetaOperationRepo, 'create' | 'update' | 'complete'>;
  clock: Clock;
  newOperationId(): string;
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : 'Meta session failed';
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
}

/**
 * Wraps a {@link SessionLauncher} so that every background `meta` launch it
 * performs is recorded in the meta-operations board — the same history that the
 * recording MetaRunner produces for `metaAi` calls. Feature/session summaries
 * and context merges launch `meta` sessions directly through the launcher (not
 * through `metaAi`), so without this decorator they consume provider credits
 * invisibly. Recording is strictly best-effort: a repo failure never disturbs
 * the underlying metasession. Only wrap the launcher handed to those direct
 * callers — never the one the MetaRunner uses, or every routed call would be
 * double-recorded.
 */
export function createRecordingSessionLauncher(
  deps: RecordingSessionLauncherDeps,
): SessionLauncher {
  const save = (op: MetaOperation, complete: boolean): void => {
    try {
      if (complete) {
        deps.operations.complete(op, null);
      } else {
        deps.operations.update(op);
      }
    } catch {
      /* Recording is best-effort; never break the metasession it observes. */
    }
  };
  return {
    async start(request: StartSessionRequest): Promise<LaunchedSession> {
      if ((request.kind ?? 'dev') !== 'meta') {
        return deps.base.start(request);
      }
      const operationId = deps.newOperationId();
      const now = deps.clock.isoNow();
      let op: MetaOperation = {
        operationId,
        featureId: request.featureId,
        automationId: null,
        originSessionId: null,
        providerId: request.providerId ?? null,
        requestedModel: request.model ?? null,
        resolvedModel: null,
        sessionId: null,
        providerSessionId: null,
        sessionIds: [],
        transport: 'unknown',
        state: 'pending',
        outcome: 'not-dispatched',
        purpose: request.purpose ?? null,
        label: request.label ?? null,
        resultText: null,
        errorMessage: null,
        usageState: 'unknown',
        usage: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
      try {
        deps.operations.create(op);
      } catch {
        /* If we cannot even record the start, fall back to a plain launch. */
        return deps.base.start(request);
      }
      let launched: LaunchedSession;
      try {
        launched = await deps.base.start(request);
      } catch (error) {
        op = {
          ...op,
          state: request.signal?.aborted ? 'interrupted' : 'failed',
          outcome: 'unknown',
          errorMessage: errorMessage(error),
          updatedAt: deps.clock.isoNow(),
          finishedAt: deps.clock.isoNow(),
        };
        save(op, false);
        throw error;
      }
      op = {
        ...op,
        providerId: launched.session.provider,
        requestedModel: launched.session.requestedModel,
        sessionId: launched.session.id,
        sessionIds: [launched.session.id],
        state: 'running',
        outcome: 'unknown',
        startedAt: deps.clock.isoNow(),
        updatedAt: deps.clock.isoNow(),
      };
      save(op, false);
      const record = (ended: Session): void => {
        const finishedAt = deps.clock.isoNow();
        if (ended.status === 'completed') {
          save(
            { ...op, state: 'completed', outcome: 'returned', updatedAt: finishedAt, finishedAt },
            true,
          );
          return;
        }
        save(
          {
            ...op,
            state: ended.status === 'cancelled' ? 'interrupted' : 'failed',
            outcome: 'unknown',
            errorMessage:
              ended.exitCode === null
                ? 'The meta session ended without an exit code.'
                : `The meta session exited with code ${ended.exitCode}.`,
            updatedAt: finishedAt,
            finishedAt,
          },
          false,
        );
      };
      const completion = launched.completion.then(
        (ended) => {
          record(ended);
          return ended;
        },
        (error) => {
          const finishedAt = deps.clock.isoNow();
          save(
            {
              ...op,
              state: request.signal?.aborted ? 'interrupted' : 'failed',
              outcome: 'unknown',
              errorMessage: errorMessage(error),
              updatedAt: finishedAt,
              finishedAt,
            },
            false,
          );
          throw error;
        },
      );
      // The caller may not await completion; keep our recording chain from
      // surfacing as an unhandled rejection (awaiters still see the original).
      completion.catch(() => {});
      return { ...launched, completion };
    },
  };
}
