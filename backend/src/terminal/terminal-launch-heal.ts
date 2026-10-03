/**
 * Self-healing for interactive terminal launches.
 *
 * When the CLI process cannot be spawned — most commonly because the session's
 * working directory no longer exists on disk (a deleted repository checkout or
 * feature worktree; Windows surfaces this as node-pty "error code: 267") — a
 * bare "Terminal: failed" tells the user nothing. This module narrates a
 * recovery attempt ("Self-healing…"), deterministically repairs the common
 * missing-directory cause, and, when it cannot, asks a metasession to explain
 * the failure before reporting a clear final message.
 *
 * The logic is pure over injected ports (filesystem, launch, diagnosis, and a
 * status emitter) so it is fully unit-testable without touching a real PTY.
 */

/** Status severity for a self-healing narration line. */
export type HealLevel = 'info' | 'success' | 'error';

/** Sink for human-readable self-healing progress, shown in the terminal. */
export type HealEmit = (level: HealLevel, message: string) => void;

/** Minimal filesystem port: existence checks and best-effort directory create. */
export interface HealFsPort {
  /** True when `path` exists and is a directory. */
  dirExists(path: string): boolean;
  /** Creates `path` (recursively). Returns true when it exists afterwards. */
  ensureDir(path: string): boolean;
}

export interface HealDecisionInput {
  /** The working directory the failed launch used (or was resolved to). */
  cwd: string;
  /** A always-valid fallback directory (the workspace/process cwd). */
  fallbackCwd: string;
  fs: HealFsPort;
  emit: HealEmit;
  /**
   * When true, the session is bound to a specific folder and must never be
   * silently relocated to a *different* directory. Repair is limited to
   * recreating the original path in place, so the session still launches
   * against its own (now-empty) folder rather than the wrong one.
   */
  inPlaceOnly?: boolean;
}

/** A repaired working directory to retry the launch in. */
export interface HealDecision {
  cwd: string;
}

/**
 * Decides how to repair a failed launch caused by a missing working directory.
 * Returns the directory to retry in, or null when the cause is not a missing
 * directory (or it cannot be repaired) — in which case the caller falls back to
 * metasession diagnosis and a final error.
 */
export function healTerminalLaunch(input: HealDecisionInput): HealDecision | null {
  const { cwd, fallbackCwd, fs, emit, inPlaceOnly } = input;
  // A present directory means the failure is something else (a missing CLI,
  // permissions, a provider error); there is nothing deterministic to repair.
  if (fs.dirExists(cwd)) {
    return null;
  }
  emit(
    'info',
    `The working directory "${cwd}" no longer exists. Attempting to restore the session…`,
  );
  // For a missing non-fallback directory (a repo checkout / feature worktree
  // that was moved or deleted) recreating it would only yield an empty folder,
  // not the original repository — so prefer starting in the valid workspace
  // root, which lets the session run while making the loss explicit. A
  // folder-bound session (inPlaceOnly) must never be relocated to a *different*
  // directory, so this fallback is skipped for it.
  if (!inPlaceOnly && cwd !== fallbackCwd && fs.dirExists(fallbackCwd)) {
    emit(
      'info',
      `Its original folder is gone; starting this session in "${fallbackCwd}" instead.`,
    );
    return { cwd: fallbackCwd };
  }
  // Recreate the original path in place. Safe for a repo-less scratch session,
  // and the only permitted repair for a folder-bound session — it relaunches in
  // its own (now-empty) folder rather than silently using the wrong directory.
  if (fs.ensureDir(cwd)) {
    emit('success', `Recreated the working directory "${cwd}".`);
    return { cwd };
  }
  emit(
    'error',
    `The working directory "${cwd}" could not be restored.`,
  );
  return null;
}

/** Renders an unknown thrown value as a single-line error string. */
export function healErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}

/**
 * The classified root cause of a failed interactive launch. Driving the
 * recovery strategy off a cause — rather than a single missing-directory check
 * — lets self-healing retry transient system errors, give a concrete fix for
 * known problems, and reserve the (slow, fragile) AI diagnosis for genuinely
 * unknown failures.
 */
export type LaunchFailureCause =
  | 'missing-cwd'
  | 'missing-cli'
  | 'permission'
  | 'transient'
  | 'unknown';

/**
 * Classifies a launch failure from its error text. Order matters: the
 * missing-directory signature (Windows `error code: 267` / "directory name is
 * invalid") is checked before the broader transient patterns because its
 * deterministic repair path differs.
 */
export function classifyLaunchFailure(errorText: string): LaunchFailureCause {
  const text = errorText.toLowerCase();
  if (
    /error code:\s*267|the directory name is invalid|chdir|no such file or directory/.test(
      text,
    )
  ) {
    return 'missing-cwd';
  }
  if (
    /enoent|command not found|is not recognized as an internal or external|spawn .* enoent|not installed/.test(
      text,
    )
  ) {
    return 'missing-cli';
  }
  if (/eperm|eacces|access is denied|permission denied|operation not permitted/.test(text)) {
    return 'permission';
  }
  if (
    /ebusy|eagain|resource temporarily unavailable|cannot create process|forkpty|the pipe has been ended|attachconsole|conpty|error code:\s*(1450|1455)/.test(
      text,
    )
  ) {
    return 'transient';
  }
  return 'unknown';
}

/**
 * A concrete, deterministic remediation message for a known failure cause, or
 * null when the cause is unknown (callers then fall back to AI diagnosis). This
 * never spawns a process, so it works even when the AI provider itself is the
 * thing that is broken or not installed.
 */
export function suggestLaunchFix(cause: LaunchFailureCause): string | null {
  switch (cause) {
    case 'missing-cli':
      return (
        'The AI CLI could not be found. Make sure the selected provider’s CLI ' +
        'is installed and on your PATH, or pick an installed provider in the ' +
        'session settings, then launch again.'
      );
    case 'permission':
      return (
        'The operating system blocked the launch (permission denied). Check ' +
        'that the working directory and the CLI are accessible and not blocked ' +
        'by antivirus, then launch again.'
      );
    case 'missing-cwd':
      return (
        'The session’s working directory is unavailable and could not be ' +
        'restored. Reopen the session from an existing folder.'
      );
    case 'transient':
      return (
        'The CLI failed to start after several attempts due to a transient ' +
        'system error. Launch again in a moment.'
      );
    case 'unknown':
      return null;
  }
}

export interface SelfHealingLaunchDeps<T> {
  /** Repository-backed sessions must never recreate an empty or shared cwd. */
  allowCwdRepair?: boolean;
  /** Launches (or reattaches) the terminal in the given working directory. */
  launch: (cwd: string) => Promise<T>;
  /** The session's resolved working directory, if any. */
  resolvedCwd: string | undefined;
  /** An always-valid fallback directory (the workspace/process cwd). */
  fallbackCwd: string;
  fs: HealFsPort;
  emit: HealEmit;
  /** How many extra attempts to make for transient failures (default 2). */
  maxRetries?: number;
  /** Delay primitive, injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Deterministic remediation for a classified cause, surfaced before (and
   * instead of) AI diagnosis. When it returns a message the AI is not invoked.
   */
  suggestFix?: (cause: LaunchFailureCause, errorText: string) => string | null;
  /**
   * Optional metasession diagnosis: given the failure text, returns a short
   * human explanation of the likely cause and fix, or null when unavailable.
   * Only consulted when `suggestFix` yields nothing (an unknown failure).
   */
  diagnose?: (errorText: string) => Promise<string | null>;
}

/** Exponential backoff (250ms, 500ms, 1s, …) capped at 2s, for retry `attempt`. */
function backoffDelay(attempt: number): number {
  return Math.min(2000, 250 * 2 ** attempt);
}

async function reportUnrecoverable<T>(
  error: unknown,
  deps: SelfHealingLaunchDeps<T>,
): Promise<void> {
  const text = healErrorText(error);
  const cause = classifyLaunchFailure(text);
  const suggestion = deps.suggestFix?.(cause, text) ?? null;
  if (suggestion) {
    deps.emit('info', suggestion);
  } else if (deps.diagnose) {
    deps.emit('info', 'Self-healing could not fix this automatically — analyzing the failure…');
    try {
      const explanation = await deps.diagnose(text);
      if (explanation) {
        deps.emit('info', explanation);
      }
    } catch {
      // A diagnosis is best-effort; never let it mask the underlying failure.
    }
  }
  deps.emit('error', `Terminal launch failed: ${text}`);
}

/**
 * Launches the terminal with bounded self-healing. Transient system errors
 * (conpty races, EBUSY/EAGAIN) are retried in place with exponential backoff.
 * A missing working directory is deterministically repaired and retried once in
 * the repaired directory. When the failure is neither transient nor a repairable
 * directory problem — or the retries are exhausted — it emits a concrete fix for
 * the classified cause (or an AI diagnosis for unknown causes) and a clear final
 * error, then rethrows so the caller marks the terminal failed.
 */
export async function launchWithSelfHealing<T>(
  deps: SelfHealingLaunchDeps<T>,
): Promise<T> {
  const cwd = deps.resolvedCwd ?? deps.fallbackCwd;
  const maxRetries = deps.maxRetries ?? 2;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.launch(cwd);
    } catch (error) {
      lastError = error;
      const cause = classifyLaunchFailure(healErrorText(error));
      if (cause !== 'transient' || attempt >= maxRetries) {
        break;
      }
      deps.emit(
        'info',
        `The CLI could not start (transient error). Retrying… (attempt ${attempt + 2} of ${maxRetries + 1})`,
      );
      await sleep(backoffDelay(attempt));
    }
  }
  const decision = healTerminalLaunch({
    cwd,
    fallbackCwd: deps.fallbackCwd,
    fs: deps.fs,
    emit: deps.emit,
    // A folder-bound session (allowCwdRepair === false) may only be repaired in
    // place — never relocated to a different cwd — so it recreates its own
    // missing directory and relaunches instead of hard-failing.
    inPlaceOnly: deps.allowCwdRepair === false,
  });
  if (decision) {
    try {
      return await deps.launch(decision.cwd);
    } catch (retryError) {
      await reportUnrecoverable(retryError, deps);
      throw retryError;
    }
  }
  await reportUnrecoverable(lastError, deps);
  throw lastError;
}
