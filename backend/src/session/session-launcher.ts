import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
import { ConflictError } from '../kernel/error-types.js';
import { createWorkTracker } from '../kernel/work-tracker.js';
import type { MetaOperationPhysicalRegistration } from '../meta/meta-operation-contract.js';
import type { ProcessAdmission, ProcessPermit } from '../kernel/process-admission.js';
import type { ProviderResolver } from '../provider/provider-resolver.js';
import type {
  RunningSession,
  SessionEvent,
  SessionSpec,
} from '../provider/provider-contract.js';
import type { SessionConfig } from './config.js';
import type { SessionFactory } from './session-factory.js';
import { assertTransition } from './session-state-machine.js';
import { createTranscriptCapture } from './transcript-capture.js';
import type { TranscriptStore } from './transcript-store-port.js';
import type { Session, StartSessionRequest } from './session-contract.js';
import {
  composeBootstrappedPrompt,
  type SessionBootstrap,
} from '../session-bootstrap/session-bootstrap.js';

/** Events published by the session orchestrator onto the kernel event bus. */
export type SessionEventMap = {
  'session.started': Session;
  'session.output': {
    sessionId: string;
    scope: NonNullable<Session['scope']>;
    event: SessionEvent;
  };
  'session.ended': Session;
  /**
   * A persisted session snapshot changed out-of-band (e.g. its resolved model
   * was discovered from usage telemetry) without starting or ending a run.
   * Lets clients refresh their live view without restarting usage tailers.
   */
  'session.updated': Session;
  /**
   * A live terminal was deliberately torn down as part of deleting its session.
   * Unlike `session.ended`, this must NOT persist a session snapshot (the row is
   * being removed); listeners use it only to release live resources such as the
   * usage tailer. Carries the session id.
   */
  'session.discarded': string;
  /**
   * A session just created or edited a file (parsed from its own terminal
   * output). Carries only the session id; clients re-fetch the authoritative
   * file list so the left-panel Files view updates live as the CLI works.
   */
  'session.file': { sessionId: string };
  /**
   * An IDE-level notice about a session that the UI surfaces outside the
   * terminal — currently a self-recovery failure the status bar shows when
   * automatic healing (re-submit → analysis → restart) could not recover a
   * session. `level` lets the UI style it (an `error` drives the bottom-bar
   * error state); `message` is user-facing text.
   */
  'session.notice': {
    sessionId: string;
    level: 'info' | 'error';
    message: string;
  };
};

export interface SessionLauncherDeps {
  physicalOwnership?: MetaOperationPhysicalRegistration;
  processAdmission?: ProcessAdmission;
  resolver: ProviderResolver;
  factory: SessionFactory;
  transcriptStore: TranscriptStore;
  bus: EventBus<SessionEventMap>;
  clock: Clock;
  config: SessionConfig;
  bootstrap: Pick<
    SessionBootstrap,
    'assertFeatureReady' | 'composeForSession'
  >;
}

/** Handle returned when a session is launched. */
export interface LaunchedSession {
  /** Session snapshot immediately after entering the 'running' state. */
  session: Session;
  running: RunningSession;
  /** Resolves with the final Session state when the run ends. */
  completion: Promise<Session>;
}

export interface SessionLauncher {
  start(request: StartSessionRequest): Promise<LaunchedSession>;
}

export interface ManagedSessionLauncher extends SessionLauncher {
  shutdown(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
  quiesceSession(sessionId: string, timeoutMs: number): Promise<boolean>;
  quiesceFeature(featureId: string, timeoutMs: number): Promise<boolean>;
}

interface LaunchOwner {
  featureId: string;
  sessionId: string | null;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  nativeStarted: boolean;
  exited: boolean;
  nativeExit: Promise<void>;
  markExited(): void;
  settle: (proof: 'not-started' | 'exited') => void;
  processPermit?: ProcessPermit;
}

function abortError(): Error {
  return new Error('Session launch cancelled');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function awaitWithSignal<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Provider-agnostic session orchestrator. Resolves the provider/model, builds
 * and advances the session through its lifecycle, streams output onto the event
 * bus, captures the transcript, and persists it when the run ends.
 */
export function createSessionLauncher(
  deps: SessionLauncherDeps,
): ManagedSessionLauncher {
  const work = createWorkTracker<LaunchOwner>();
  const blockedFeatures = new Set<string>();
  const blockedSessions = new Set<string>();
  let stopped = false;
  const settle = (owner: LaunchOwner) => {
    if (owner.pending.size === 0 && (!owner.nativeStarted || owner.exited)) {
      owner.processPermit?.release();
      owner.settle(owner.nativeStarted ? 'exited' : 'not-started');
    }
  };
  const own = <T>(owner: LaunchOwner, run: () => Promise<T>): Promise<T> => {
    const task: Promise<T> = work.own(owner, async () => {
      let result: T;
      try {
        result = await run();
      } finally {
        owner.pending.delete(task);
        settle(owner);
      }
      return result;
    });
    owner.pending.add(task);
    return task;
  };

  async function launch(
    request: StartSessionRequest & { signal: AbortSignal },
    owner: LaunchOwner,
  ): Promise<LaunchedSession> {
      throwIfAborted(request.signal);
      const admission = deps.processAdmission;
      if (admission) {
        owner.processPermit = await own(owner, () => admission.acquireCold(request.signal));
        throwIfAborted(request.signal);
      }
      const kind = request.kind ?? deps.config.defaultKind;
      const scope = request.scope ?? 'feature';
      if (kind === 'dev' && scope !== 'internal') {
        await awaitWithSignal(
          own(owner, async () => {
            throwIfAborted(request.signal);
            await deps.bootstrap.assertFeatureReady(request.featureId);
          }),
          request.signal,
        );
      }
      throwIfAborted(request.signal);
      const selection = await awaitWithSignal(
        own(owner, () => {
          throwIfAborted(request.signal);
          return deps.resolver.resolve({
            providerId: request.providerId,
            model: request.model,
          });
        }),
        request.signal,
      );
      throwIfAborted(request.signal);

      const created = deps.factory.build({
        featureId: request.featureId,
        provider: selection.provider.id,
        requestedModel: selection.model,
        kind,
        scope,
        prompt: request.prompt,
      });
      owner.sessionId = created.id;
      if (blockedSessions.has(created.id)) owner.controller.abort();
      throwIfAborted(request.signal);
      const bootstrap =
        created.kind === 'dev' && created.scope !== 'internal'
          ? await awaitWithSignal(
              own(owner, () => {
                throwIfAborted(request.signal);
                return deps.bootstrap.composeForSession(created);
              }),
              request.signal,
            )
          : '';
      throwIfAborted(request.signal);
      const launchPrompt = composeBootstrappedPrompt(bootstrap, request.prompt);

      assertTransition(created.status, 'running');
      const session: Session = {
        ...created,
        status: 'running',
        startedAt: deps.clock.isoNow(),
      };
      const spec: SessionSpec = {
        sessionId: session.id,
        featureId: session.featureId,
        prompt: launchPrompt,
        attachments: request.attachments,
        model: session.requestedModel,
        kind: session.kind,
        otelFilePath: session.usageFilePath,
        cwd: request.cwd,
        noTools: request.noTools,
      };

      let running: RunningSession;
      try {
        deps.bus.emit('session.started', session);
        throwIfAborted(request.signal);
        running = selection.provider.startSession(spec);
        owner.nativeStarted = true;
        void work.own(owner, () => owner.nativeExit);
      } catch (error) {
        try {
          deps.bus.emit('session.ended', {
            ...session,
            status: request.signal?.aborted ? 'cancelled' : 'failed',
            endedAt: deps.clock.isoNow(),
            exitCode: null,
          });
        } catch (publicationError) {
          throw new AggregateError([error, publicationError], 'Session startup failure could not be finalized');
        }
        throw error;
      }
      const abortRunning = () => {
        try {
          running.kill();
        } catch {
          // Best effort: the provider may already be gone.
        }
      };
      if (request.signal?.aborted) {
        abortRunning();
      } else {
        request.signal?.addEventListener('abort', abortRunning, { once: true });
      }
      const capture = createTranscriptCapture(session.id);
      let acceptingOutput = true;
      const completion = own(owner, async () => {
        const code = await running.done;
        owner.markExited();
        acceptingOutput = false;
        request.signal?.removeEventListener('abort', abortRunning);
        const outcomeStatus = request.signal?.aborted
          ? 'cancelled'
          : code === 0
            ? 'completed'
            : 'failed';
        assertTransition('running', outcomeStatus);
        const ended: Session = {
          ...session,
          status: outcomeStatus,
          endedAt: deps.clock.isoNow(),
          exitCode: code,
        };
        try {
          await deps.transcriptStore.save(capture.result());
          deps.bus.emit('session.ended', ended);
          return ended;
        } catch (error) {
          const failed: Session = {
            ...ended,
            status: 'failed',
          };
          deps.bus.emit('session.ended', failed);
          throw error;
        }
      });
      running.onEvent((event) => {
        if (event.type === 'exit') {
          owner.markExited();
          settle(owner);
        }
        if (!acceptingOutput) return;
        capture.record(event);
        deps.bus.emit('session.output', {
          sessionId: session.id,
          scope,
          event,
        });
      });

      // Guard against an unhandled rejection if a caller does not await
      // `completion` (e.g. a fire-and-forget interactive launch). Real awaiters
      // still observe the rejection through their own `await`/`.catch`.
      completion.catch(() => {});

      return { session, running, completion };
  }

  const abortMatching = (matches: (owner: LaunchOwner) => boolean) => {
    for (const owner of work.keys()) {
      if (matches(owner)) owner.controller.abort();
    }
  };

  return {
    async start(request) {
      if (stopped || blockedFeatures.has(request.featureId)) {
        throw new ConflictError('Session launch blocked by shutdown or deletion');
      }
      let markExited!: () => void;
      const nativeExit = new Promise<void>((resolve) => { markExited = resolve; });
      const owner: LaunchOwner = {
        featureId: request.featureId, sessionId: null, controller: new AbortController(),
        pending: new Set(), nativeStarted: false, exited: false, settle: () => {},
        nativeExit, markExited: () => { owner.exited = true; owner.processPermit?.release(); markExited(); },
      };
      if (request.operationId && deps.physicalOwnership) {
        const settled = new Promise<'not-started' | 'exited'>((resolve) => { owner.settle = resolve; });
        deps.physicalOwnership.register(request.operationId, {
          ownerId: deps.physicalOwnership.newOwnerId(), settled,
          quiesce: async () => {
            owner.controller.abort();
            return owner.pending.size === 0 && (!owner.nativeStarted || owner.exited)
              ? owner.nativeStarted ? 'exited' : 'not-started' : 'unconfirmed';
          },
        });
      }
      const abort = () => owner.controller.abort();
      const detach = () => request.signal?.removeEventListener('abort', abort);
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
      try {
        const launched = await own(owner, () =>
          launch({ ...request, signal: owner.controller.signal }, owner));
        void launched.completion.then(detach, detach);
        return launched;
      } catch (error) {
        owner.controller.abort();
        detach();
        throw error;
      }
    },
    shutdown() {
      stopped = true;
      abortMatching(() => true);
    },
    waitForIdle: (timeoutMs) => work.waitForIdle(timeoutMs),
    quiesceSession(sessionId, timeoutMs) {
      blockedSessions.add(sessionId);
      const matches = (owner: LaunchOwner) => owner.sessionId === sessionId;
      abortMatching(matches);
      return work.waitForIdle(timeoutMs, matches);
    },
    quiesceFeature(featureId, timeoutMs) {
      blockedFeatures.add(featureId);
      const matches = (owner: LaunchOwner) => owner.featureId === featureId;
      abortMatching(matches);
      return work.waitForIdle(timeoutMs, matches);
    },
  };
}
