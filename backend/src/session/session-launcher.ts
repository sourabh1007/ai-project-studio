import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
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

/** Events published by the session orchestrator onto the kernel event bus. */
export type SessionEventMap = {
  'session.started': Session;
  'session.output': { sessionId: string; event: SessionEvent };
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
};

export interface SessionLauncherDeps {
  resolver: ProviderResolver;
  factory: SessionFactory;
  transcriptStore: TranscriptStore;
  bus: EventBus<SessionEventMap>;
  clock: Clock;
  config: SessionConfig;
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

/**
 * Provider-agnostic session orchestrator. Resolves the provider/model, builds
 * and advances the session through its lifecycle, streams output onto the event
 * bus, captures the transcript, and persists it when the run ends.
 */
export function createSessionLauncher(
  deps: SessionLauncherDeps,
): SessionLauncher {
  return {
    async start(request) {
      const selection = await deps.resolver.resolve({
        providerId: request.providerId,
        model: request.model,
      });
      const kind = request.kind ?? deps.config.defaultKind;

      const created = deps.factory.build({
        featureId: request.featureId,
        provider: selection.provider.id,
        requestedModel: selection.model,
        kind,
        prompt: request.prompt,
      });

      assertTransition(created.status, 'running');
      const session: Session = {
        ...created,
        status: 'running',
        startedAt: deps.clock.isoNow(),
      };
      deps.bus.emit('session.started', session);

      const spec: SessionSpec = {
        sessionId: session.id,
        featureId: session.featureId,
        prompt: session.prompt,
        model: session.requestedModel,
        kind: session.kind,
        otelFilePath: session.usageFilePath,
        cwd: request.cwd,
      };

      const running = selection.provider.startSession(spec);
      const capture = createTranscriptCapture(session.id);
      running.onEvent((event) => {
        capture.record(event);
        deps.bus.emit('session.output', { sessionId: session.id, event });
      });

      const completion = running.done.then(async (code) => {
        const nextStatus = code === 0 ? 'completed' : 'failed';
        assertTransition('running', nextStatus);
        const ended: Session = {
          ...session,
          status: nextStatus,
          endedAt: deps.clock.isoNow(),
          exitCode: code,
        };
        await deps.transcriptStore.save(capture.result());
        deps.bus.emit('session.ended', ended);
        return ended;
      });

      // Guard against an unhandled rejection if a caller does not await
      // `completion` (e.g. a fire-and-forget interactive launch). Real awaiters
      // still observe the rejection through their own `await`/`.catch`.
      completion.catch(() => {});

      return { session, running, completion };
    },
  };
}
