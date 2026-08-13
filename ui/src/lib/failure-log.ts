/**
 * A bounded, in-memory recorder of recent client-side failures (Phase 4e).
 *
 * The renderer has no central place that remembers what went wrong, which makes
 * a Diagnostics/Recovery surface impossible to populate. This keeps a small ring
 * buffer of the most recent failures (newest first, capped) that the
 * ErrorBoundary and key catch sites can feed, so the user can review recent
 * problems and include them when exporting diagnostics. It is intentionally
 * in-memory only (local, ephemeral, no persistence, no network).
 */

export interface FailureEntry {
  /** ISO timestamp of when the failure was recorded. */
  readonly at: string;
  /** Where the failure originated (e.g. "Settings", "ErrorBoundary"). */
  readonly context: string;
  /** Human-readable failure message. */
  readonly message: string;
}

/** Maximum number of failures retained; older entries are dropped. */
export const MAX_FAILURES = 25;

let entries: FailureEntry[] = [];

/** Records a failure at the front of the buffer and returns the stored entry. */
export function recordFailure(context: string, error: unknown): FailureEntry {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);
  const entry: FailureEntry = {
    at: new Date().toISOString(),
    context,
    message,
  };
  entries = [entry, ...entries].slice(0, MAX_FAILURES);
  return entry;
}

/** Returns the recorded failures, newest first. */
export function listFailures(): readonly FailureEntry[] {
  return entries;
}

/** Clears all recorded failures. */
export function clearFailures(): void {
  entries = [];
}
