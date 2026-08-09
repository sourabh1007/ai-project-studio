import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { Session, SessionScope } from '../session/session-contract.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { MetaConfig } from './config.js';
import { extractResponseText } from './meta-response-extractor.js';
import { describeMetaActivity } from './meta-activity.js';
import type { Transcript } from '../session/transcript-capture.js';

const MAX_PROVIDER_FAILURE_CHARS = 500;

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
  launcher: SessionLauncher;
  transcripts: TranscriptStore;
  config: MetaConfig;
}

/** A single headless AI request: a prompt run against a feature's context. */
export interface MetaRequest {
  /**
   * Usage attribution partition. Feature work uses its feature id; internal
   * repository analysis may use a stable repository-derived id.
   */
  featureId: string;
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
   * Internal scope keeps infrastructure runs out of feature session views
   * while their `meta` usage remains part of IDE AI accounting.
   */
  scope?: SessionScope;
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

/** The text a metasession produced together with its session id. */
export interface MetaRunResult {
  text: string;
  sessionId: string;
}

export function createMetaRunner(deps: MetaRunnerDeps): MetaRunner {
  const runDetailed = async (request: MetaRequest): Promise<MetaRunResult> => {
    const launched = await deps.launcher.start({
      featureId: request.featureId,
      providerId: deps.config.providerId,
      model: deps.config.model,
      prompt: request.prompt,
      attachments: request.attachments,
      kind: 'meta',
      cwd: request.cwd,
      scope: request.scope,
      noTools: request.noTools,
    });
    const sessionId = launched.session.id;
    request.onStart?.(sessionId);
    if (request.onActivity) {
      const emit = request.onActivity;
      launched.running.onEvent((event) => {
        if (event.type === 'stdout' || event.type === 'stderr') {
          const line = describeMetaActivity(event.line);
          if (line !== null) {
            emit(line);
          }
        }
      });
    }
    const ended = await awaitWithTimeout(
      launched,
      request.timeoutMs ?? deps.config.timeoutMs,
    );
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
    };
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
  timeoutMs: number,
): Promise<MetaCompletion> {
  return new Promise<MetaCompletion>((resolve, reject) => {
    let completedTurn = false;
    const timer = setTimeout(() => {
      try {
        launched.running.kill();
      } catch {
        // Best effort: the process may already be gone.
      }
      reject(new Error(`Provider timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Never let the guard timer keep the process alive on its own.
    timer.unref();
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
        clearTimeout(timer);
        resolve({ session, completedTurn });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
