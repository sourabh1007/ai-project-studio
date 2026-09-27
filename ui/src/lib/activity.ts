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
  /** Start time of the oldest request still pending, not a progress estimate. */
  oldestStartedAt?: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: ActivitySnapshot = { pending: 0, label: null, error: null };
const operations = new Map<symbol, { label: string; startedAt: number }>();

function update(error: string | null): void {
  const active = [...operations.values()];
  snapshot = {
    pending: active.length,
    label: active.at(-1)?.label ?? null,
    error,
    ...(active.length > 0 ? { oldestStartedAt: active[0].startedAt } : {}),
  };
  emit();
}

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
export function beginActivity(label: string): symbol {
  const token = Symbol();
  operations.set(token, { label, startedAt: Date.now() });
  update(null);
  return token;
}

/** Marks an operation as finished successfully. */
export function endActivity(token?: symbol): void {
  operations.delete(token ?? operations.keys().next().value!);
  update(snapshot.error);
}

/** Marks an operation as finished with an error. */
export function failActivity(message: string, token?: symbol): void {
  operations.delete(token ?? operations.keys().next().value!);
  update(message);
}

/** Dismisses the current error (e.g. after the user acknowledges it). */
export function clearActivityError(): void {
  if (snapshot.error === null) {
    return;
  }
  snapshot = { ...snapshot, error: null };
  emit();
}

export function activityDelay(activity: ActivitySnapshot, now: number): number | null {
  if (activity.pending === 0 || activity.oldestStartedAt === undefined) return null;
  const elapsed = Math.max(0, Math.floor((now - activity.oldestStartedAt) / 1_000));
  return elapsed >= 10 ? elapsed : null;
}
