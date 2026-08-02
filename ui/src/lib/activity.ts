/**
 * A tiny global "is anything happening?" store. Every API request reports into
 * it (see api-context), so the status bar can always show whether the app is
 * working, idle, or hit an error — the user is never left wondering if a click
 * did anything. Deliberately framework-free so it can be driven from the API
 * client wrapper and read via `useSyncExternalStore`.
 */

export interface ActivitySnapshot {
  /** Number of in-flight operations. */
  pending: number;
  /** Human-readable label of the most recent operation, when busy. */
  label: string | null;
  /** The most recent error message, until cleared or superseded. */
  error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: ActivitySnapshot = { pending: 0, label: null, error: null };

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribes to activity changes; returns an unsubscribe function. */
export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current snapshot (stable reference until something changes). */
export function getActivitySnapshot(): ActivitySnapshot {
  return snapshot;
}

/** Marks an operation as started, clearing any prior error. */
export function beginActivity(label: string): void {
  snapshot = { pending: snapshot.pending + 1, label, error: null };
  emit();
}

/** Marks an operation as finished successfully. */
export function endActivity(): void {
  const pending = Math.max(0, snapshot.pending - 1);
  snapshot = {
    pending,
    label: pending > 0 ? snapshot.label : null,
    error: snapshot.error,
  };
  emit();
}

/** Marks an operation as finished with an error. */
export function failActivity(message: string): void {
  const pending = Math.max(0, snapshot.pending - 1);
  snapshot = {
    pending,
    label: pending > 0 ? snapshot.label : null,
    error: message,
  };
  emit();
}

/** Dismisses the current error (e.g. after the user acknowledges it). */
export function clearActivityError(): void {
  if (snapshot.error === null) {
    return;
  }
  snapshot = { ...snapshot, error: null };
  emit();
}
