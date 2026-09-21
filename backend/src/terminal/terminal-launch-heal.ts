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
  const { cwd, fallbackCwd, fs, emit } = input;
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
  // root, which lets the session run while making the loss explicit.
  if (cwd !== fallbackCwd && fs.dirExists(fallbackCwd)) {
    emit(
      'info',
      `Its original folder is gone; starting this session in "${fallbackCwd}" instead.`,
    );
    return { cwd: fallbackCwd };
  }
  // The fallback itself is the missing directory (a repo-less scratch session):
  // recreating it is safe and restores the session in place.
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

export interface SelfHealingLaunchDeps<T> {
  /** Launches (or reattaches) the terminal in the given working directory. */
  launch: (cwd: string) => Promise<T>;
  /** The session's resolved working directory, if any. */
  resolvedCwd: string | undefined;
  /** An always-valid fallback directory (the workspace/process cwd). */
  fallbackCwd: string;
  fs: HealFsPort;
  emit: HealEmit;
  /**
   * Optional metasession diagnosis: given the failure text, returns a short
   * human explanation of the likely cause and fix, or null when unavailable.
   */
  diagnose?: (errorText: string) => Promise<string | null>;
}

async function reportUnrecoverable(
  error: unknown,
  emit: HealEmit,
  diagnose?: (errorText: string) => Promise<string | null>,
): Promise<void> {
  const text = healErrorText(error);
  if (diagnose) {
    emit('info', 'Self-healing could not fix this automatically — analyzing the failure…');
    try {
      const explanation = await diagnose(text);
      if (explanation) {
        emit('info', explanation);
      }
    } catch {
      // A diagnosis is best-effort; never let it mask the underlying failure.
    }
  }
  emit('error', `Terminal launch failed: ${text}`);
}

/**
 * Launches the terminal with a bounded self-healing retry. On the first
 * failure it narrates and attempts a deterministic repair of a missing working
 * directory, retrying once in the repaired directory. If the failure is not a
 * repairable directory problem, or the retry also fails, it emits a metasession
 * diagnosis (when available) and a clear final error, then rethrows so the
 * caller marks the terminal failed.
 */
export async function launchWithSelfHealing<T>(
  deps: SelfHealingLaunchDeps<T>,
): Promise<T> {
  const cwd = deps.resolvedCwd ?? deps.fallbackCwd;
  try {
    return await deps.launch(cwd);
  } catch (error) {
    const decision = healTerminalLaunch({
      cwd,
      fallbackCwd: deps.fallbackCwd,
      fs: deps.fs,
      emit: deps.emit,
    });
    if (decision) {
      try {
        return await deps.launch(decision.cwd);
      } catch (retryError) {
        await reportUnrecoverable(retryError, deps.emit, deps.diagnose);
        throw retryError;
      }
    }
    await reportUnrecoverable(error, deps.emit, deps.diagnose);
    throw error;
  }
}
