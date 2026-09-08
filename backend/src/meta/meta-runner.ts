import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { Session, SessionScope } from '../session/session-contract.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { MetaConfig } from './config.js';
import type { MetaSettings } from './meta-settings.js';
import { extractResponseText } from './meta-response-extractor.js';
import { describeMetaActivity } from './meta-activity.js';
import type { Transcript } from '../session/transcript-capture.js';
import type { MetaOperationPhysicalRegistration } from './meta-operation-contract.js';
import { registerUnstartedMetaAttempt } from './meta-operation-physical-ownership.js';

const MAX_PROVIDER_FAILURE_CHARS = 500;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

function safeFailureText(value: string): string {
  const normalized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > MAX_PROVIDER_FAILURE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_FAILURE_CHARS - 1)}…`
    : normalized;
}

/**
 * True when a raw provider output line is the Copilot CLI's terminal `result`
 * event. In `-p` JSON print mode the CLI emits this once the turn is fully done
 * (after the final `assistant.message`/`assistant.idle`), but the process does
 * not always exit on its own — it can linger, which would otherwise force the
 * caller to wait out the whole timeout before failing. Detecting it lets the
 * runner finish the moment the answer is complete.
 */
function isTerminalResultLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== '{') {
    return false;
  }
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    return event.type === 'result';
  } catch {
    return false;
  }
}

function sessionError(line: string): string | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type !== 'session.error' || typeof event.data !== 'object' || !event.data) {
      return null;
    }
    const data = event.data as Record<string, unknown>;
    for (const key of ['message', 'error', 'content']) {
      if (typeof data[key] === 'string' && data[key].trim()) return data[key] as string;
    }
  } catch {
    return null;
  }
  return null;
}

function providerFailure(transcript: Transcript | null, exitCode: number | null): Error {
  const eventErrors = (transcript?.stdout ?? [])
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .map(sessionError)
    .filter((message): message is string => message !== null);
  const stderr = (transcript?.stderr ?? []).filter((line) => line.trim().length > 0);
  const detail = safeFailureText(eventErrors.at(-1) ?? stderr.at(-1) ?? '');
  const code = exitCode === null ? '' : ` (exit code ${exitCode})`;
  return new Error(`Provider failed${code}${detail ? `: ${detail}` : ''}`);
}

export interface MetaRunnerDeps {
  physicalOwnership?: MetaOperationPhysicalRegistration;
  launcher: SessionLauncher;
  transcripts: TranscriptStore;
  config: MetaConfig;
  /**
   * Runtime-mutable provider/model override read fresh on every run. When
   * present its values take precedence over the static {@link config}, so the
   * IDE can change which model powers new metasessions without a restart. When
   * omitted the runner falls back to the config's `providerId`/`model`.
   */
  settings?: Pick<MetaSettings, 'get'>;
}

export type MetaStopKind = 'aborted' | 'timed_out';
export type MetaTerminationState = 'not-started' | 'confirmed' | 'unconfirmed';

export class MetaAbortError extends Error {
  readonly kind: MetaStopKind;
  readonly termination: MetaTerminationState;

  constructor(options: {
    kind: MetaStopKind;
    timeoutMs?: number;
    termination: MetaTerminationState;
    cause?: unknown;
  }) {
    super(metaAbortMessage(options.kind, options.timeoutMs, options.termination), {
      cause: options.cause,
    });
    this.name = 'MetaAbortError';
    this.kind = options.kind;
    this.termination = options.termination;
  }
}

function metaAbortMessage(
  kind: MetaStopKind,
  timeoutMs: number | undefined,
  termination: MetaTerminationState,
): string {
  const base =
    kind === 'timed_out'
      ? `Provider timed out after ${timeoutMs}ms`
      : 'Meta request cancelled';
  if (termination === 'not-started') {
    return `${base} before it started`;
  }
  if (termination === 'unconfirmed') {
    return `${base}; termination was requested but not confirmed`;
  }
  return base;
}

/** A single headless AI request: a prompt run against a feature's context. */
export interface MetaRequest {
  /**
   * Usage attribution partition. Feature work uses its feature id; internal
   * repository analysis may use a stable repository-derived id.
   */
  featureId: string;
  /** Stable ownership anchors for durable operation attribution and deletion. */
  automationId?: string;
  originSessionId?: string;
  /** Stamped by the recording boundary; identifies immutable physical attempts. */
  operationId?: string;
  /** Optional provider override for this one metasession. */
  providerId?: string;
  /** Optional model override for this one metasession. */
  model?: string;
  prompt: string;
  /** Absolute paths attached to the provider's initial prompt. */
  attachments?: readonly string[];
  /** Working directory used by the provider CLI for repository-aware work. */
  cwd?: string;
  /**
   * Restrict the run to zero tools, making it a pure prompt→text completion
   * with no agentic tool loops. Lightweight callers (e.g. PR review) that embed
   * everything the model needs in the prompt set this so the run returns fast
   * and can never wedge waiting on a tool.
   */
  noTools?: boolean;
  /**
   * Per-request hard timeout (ms) overriding the runner's configured ceiling.
   * Lets a caller bound a lightweight step more tightly than a full agentic
   * turn so a stall surfaces as a failed step quickly instead of spinning.
   */
  timeoutMs?: number;
  /**
   * Internal absolute deadline (epoch ms) for this request. Callers should set
   * {@link timeoutMs}; wrappers stamp this once so retries or warm/cold routing
   * do not restart the timeout budget part-way through a run.
   */
  deadlineAt?: number;
  /**
   * Internal scope keeps infrastructure runs out of feature session views
   * while their `meta` usage remains part of IDE AI accounting.
   */
  scope?: SessionScope;
  /**
   * Warm-pool routing key. When warm pools are enabled the request leases a
   * live session from the pool whose configured `purpose` matches this value;
   * unset or unmatched requests use the shared `general` pool. Ignored on the
   * cold path.
   */
  purpose?: string;
  /**
   * Short, human-readable description of the concrete work this turn performs
   * (e.g. "PR review · problem statement", "Explain file src/foo.ts",
   * "Repository analysis"). Recorded against the warm session's usage history so
   * the Settings page can show *what* a session was used for, not just the
   * coarse routing purpose. Falls back to the purpose when unset.
   */
  label?: string;
  /**
   * Invoked with the metasession id the moment it launches, before completion,
   * so callers can attribute in-flight progress (e.g. stream live activity) to
   * the session while it runs.
   */
  onStart?: (sessionId: string) => void;
  /**
   * Invoked with each concise, human-readable activity line the metasession
   * produces as it runs (assistant messages, tool calls, diagnostics). Lets a
   * caller surface what the metasession is actually doing in real time.
   */
  onActivity?: (line: string) => void;
  /** Aborts launch/execution when the caller no longer wants the result. */
  signal?: AbortSignal;
}

/**
 * Reusable "AI" primitive: launches a headless `meta` CLI session for a prompt,
 * awaits completion, and returns the extracted assistant response text. Factored
 * out so every AI feature (summaries, task plans, …) shares one config-driven
 * flow instead of duplicating the launcher/extractor plumbing. Meta sessions are
 * excluded from dev-cost rollups by the aggregation module.
 */
export interface MetaRunner {
  run(request: MetaRequest): Promise<string>;
  /**
   * Like {@link run} but also returns the metasession id, so callers that need
   * to attribute the run's tokens/credits (e.g. the PR review's per-step
   * metasession accounting) can look its usage up afterwards.
   */
  runDetailed(request: MetaRequest): Promise<MetaRunResult>;
}

export type MetaResultTransport = 'session' | 'warm-acp';

export interface MetaUsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  nanoAiu: number | null;
  credits: number | null;
}

/** The text a metasession produced together with its durable attribution. */
export interface MetaRunResult {
  text: string;
  sessionId: string;
  operationId?: string;
  transport?: MetaResultTransport;
  providerId?: string;
  requestedModel?: string;
  resolvedModel?: string | null;
  providerSessionId?: string | null;
  usage?: MetaUsageSnapshot | null;
}

export function createMetaRunner(deps: MetaRunnerDeps): MetaRunner {
  const runDetailed = async (request: MetaRequest): Promise<MetaRunResult> => {
    const defaults = deps.settings?.get() ?? {
      providerId: deps.config.providerId,
      model: deps.config.model,
    };
    const providerId = request.providerId ?? defaults.providerId;
    const model = request.model ?? defaults.model;
    const timeoutMs = request.timeoutMs ?? deps.config.timeoutMs;
    const deadlineAt = request.deadlineAt ?? Date.now() + timeoutMs;
    if (request.signal?.aborted) {
      registerUnstartedMetaAttempt(deps.physicalOwnership, request.operationId);
      throw new MetaAbortError({
        kind: 'aborted',
        termination: 'not-started',
      });
    }
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort();
    request.signal?.addEventListener('abort', forwardAbort, { once: true });
    const remainingLaunchMs = Math.max(0, deadlineAt - Date.now());
    if (remainingLaunchMs === 0) {
      request.signal?.removeEventListener('abort', forwardAbort);
      registerUnstartedMetaAttempt(deps.physicalOwnership, request.operationId);
      throw new MetaAbortError({
        kind: 'timed_out',
        timeoutMs,
        termination: 'not-started',
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingLaunchMs);
    timer.unref?.();

    try {
      let launched: LaunchedSession;
      try {
        launched = await deps.launcher.start({
          featureId: request.featureId,
          operationId: request.operationId,
          providerId,
          model,
          prompt: request.prompt,
          attachments: request.attachments,
          kind: 'meta',
          cwd: request.cwd,
          scope: request.scope,
          noTools: request.noTools,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new MetaAbortError({
            kind: timedOut ? 'timed_out' : 'aborted',
            timeoutMs,
            termination: 'not-started',
            cause: error,
          });
        }
        throw error;
      }
      const sessionId = launched.session.id;
      request.onStart?.(sessionId);
      let publishActivity = true;
      if (request.onActivity) {
        const emit = request.onActivity;
        launched.running.onEvent((event) => {
          if (
            publishActivity &&
            (event.type === 'stdout' || event.type === 'stderr')
          ) {
            const line = describeMetaActivity(event.line);
            if (line !== null) {
              emit(line);
            }
          }
        });
      }
      const ended = await awaitWithTimeout(launched, {
        timeoutMs,
        signal: controller.signal,
        onStopPublishing: () => {
          publishActivity = false;
        },
        timedOut: () => timedOut,
      });
      const transcript = await deps.transcripts.load(ended.session.id);
      if (
        !ended.completedTurn &&
        (ended.session.status === 'failed' ||
          (ended.session.exitCode !== null && ended.session.exitCode !== 0))
      ) {
        throw providerFailure(transcript, ended.session.exitCode);
      }
      return {
        text: extractResponseText(transcript, deps.config.responseTextKeys),
        sessionId,
        transport: 'session',
        providerId,
        requestedModel: model,
        resolvedModel: ended.session.resolvedModel,
        providerSessionId: null,
        usage: null,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', forwardAbort);
    }
  };
  return {
    async run(request) {
      return (await runDetailed(request)).text;
    },
    runDetailed,
  };
}

/** Outcome of awaiting a metasession: the ended session plus whether it was
 * finished early because the CLI emitted its terminal `result` event (in which
 * case a non-zero exit code from our own kill must NOT be treated as a failure). */
interface MetaCompletion {
  session: Session;
  completedTurn: boolean;
}

/**
 * Awaits a launched session's completion, but kills the underlying provider
 * process and rejects if it has not finished within `timeoutMs`. This bounds
 * every metasession so a wedged CLI (e.g. one blocked on a prompt despite
 * `--allow-all-tools`) fails fast instead of hanging the caller forever.
 *
 * As a fast path it also watches the provider's output for the terminal
 * `result` event: the Copilot CLI emits it once the turn is complete but does
 * not reliably exit afterwards in `-p` JSON print mode, so without this the
 * caller would wait out the entire timeout even though the answer is already
 * in. On seeing it we kill the process (making `completion` resolve at once)
 * and flag the run as a completed turn so its non-zero kill exit is treated as
 * success rather than a provider failure.
 */
function awaitWithTimeout(
  launched: LaunchedSession,
  options: {
    timeoutMs: number;
    signal: AbortSignal;
    onStopPublishing: () => void;
    timedOut: () => boolean;
  },
): Promise<MetaCompletion> {
  return new Promise<MetaCompletion>((resolve, reject) => {
    let completedTurn = false;
    let settled = false;
    let stopRequested = false;
    let stopKind: MetaStopKind = 'aborted';
    const stop = (): void => {
      stopRequested = true;
      stopKind = options.timedOut() ? 'timed_out' : 'aborted';
      options.onStopPublishing();
      try {
        launched.running.kill();
      } catch {
        // Best effort: the process may already be gone.
      }
      const grace = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new MetaAbortError({
            kind: stopKind,
            timeoutMs: options.timeoutMs,
            termination: 'unconfirmed',
          }),
        );
      }, DEFAULT_TERMINATION_GRACE_MS);
      grace.unref?.();
    };
    if (options.signal.aborted) {
      stop();
    } else {
      options.signal.addEventListener('abort', stop, { once: true });
    }
    launched.running.onEvent((event) => {
      if (
        !completedTurn &&
        event.type === 'stdout' &&
        isTerminalResultLine(event.line)
      ) {
        completedTurn = true;
        try {
          launched.running.kill();
        } catch {
          // Best effort: the process may already be exiting.
        }
      }
    });
    launched.completion.then(
      (session) => {
        if (settled) {
          return;
        }
        settled = true;
        options.signal.removeEventListener('abort', stop);
        if (stopRequested) {
          reject(
            new MetaAbortError({
              kind: stopKind,
              timeoutMs: options.timeoutMs,
              termination: 'confirmed',
            }),
          );
          return;
        }
        resolve({ session, completedTurn });
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        options.signal.removeEventListener('abort', stop);
        if (stopRequested) {
          reject(
            new MetaAbortError({
              kind: stopKind,
              timeoutMs: options.timeoutMs,
              termination: 'confirmed',
              cause: error,
            }),
          );
          return;
        }
        reject(error);
      },
    );
  });
}
