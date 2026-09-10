/**
 * Backend crash evidence recorded by the desktop main process.
 *
 * The backend cannot log its own hard exit and the renderer's in-memory notice
 * dies with the next reload, so the supervisor persists these records instead.
 * They are the only account of *why* the app went unreachable.
 */
export interface BackendFailure {
  /** ISO timestamp of when the supervisor recorded the failure. */
  at: string;
  /** `exit` — the process died; `unavailable` — restarts were given up on. */
  kind: 'exit' | 'unavailable';
  /** Process exit code, when the process exited on its own. */
  code?: number | null;
  /** Terminating signal, when one was delivered. */
  signal?: string | null;
  /** Why the supervisor stopped trying, for `unavailable` records. */
  reason?: string;
  /** Tail of the backend's stderr — usually the actual stack trace. */
  stderrTail?: string;
  /** How long the process had been running before it died. */
  uptimeMs?: number;
}

/** What the desktop bridge reports about backend health. */
export interface BackendDiagnostics {
  logDirectory: string | null;
  failures: readonly BackendFailure[];
}

/** Narrows an untrusted IPC payload to {@link BackendDiagnostics}. */
export function readBackendDiagnostics(value: unknown): BackendDiagnostics | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return {
    logDirectory:
      typeof raw.logDirectory === 'string' ? raw.logDirectory : null,
    failures: Array.isArray(raw.failures)
      ? (raw.failures.filter(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            typeof (entry as BackendFailure).at === 'string',
        ) as BackendFailure[])
      : [],
  };
}

/**
 * One-line summary of how the backend died, for the diagnostics list. Prefers
 * the supervisor's own reason, then the signal, then the exit code — a signal
 * is more informative than the code it produces (a SIGKILL from the OS reads
 * very differently from a code 1 crash).
 */
export function describeBackendFailure(failure: BackendFailure): string {
  if (failure.kind === 'unavailable') {
    return failure.reason
      ? `Gave up restarting the backend: ${failure.reason}`
      : 'Gave up restarting the backend';
  }
  if (failure.signal) {
    return `Backend was terminated by ${failure.signal}`;
  }
  if (typeof failure.code === 'number') {
    return `Backend exited with code ${failure.code}`;
  }
  return 'Backend exited for an unknown reason';
}

/**
 * The most useful line of a stderr tail: the last non-empty one, which is
 * where a Node crash puts its error. Empty string when there is nothing.
 */
export function backendFailureDetail(failure: BackendFailure): string {
  const lines = (failure.stderrTail ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}
