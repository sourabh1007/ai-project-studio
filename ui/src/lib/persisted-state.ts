/**
 * Pure, storage-agnostic helpers for persisting small pieces of UI context
 * (panel sizes, last-selected view, scroll offsets) across reloads. The React
 * `usePersistentState` hook builds on these; keeping the logic pure makes the
 * JSON-safety, validation, and clamping fully unit-testable without a DOM.
 */

/** The minimal shape we need from `window.localStorage` (or a fake in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read a persisted JSON value, validating it before use. Any parse error,
 * missing key, or failed validation falls back to `fallback` so a corrupt or
 * outdated entry never breaks the UI. Storage access is wrapped defensively
 * because `localStorage` can throw (private mode, quota, disabled).
 */
export function readPersisted<T>(
  store: KeyValueStore,
  key: string,
  validate: (value: unknown) => value is T,
  fallback: T,
): T {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  return validate(parsed) ? parsed : fallback;
}

/**
 * Persist a value as JSON. Returns whether the write succeeded; failures (quota,
 * disabled storage) are swallowed so persistence stays best-effort and never
 * throws into render/effect code.
 */
export function writePersisted(
  store: KeyValueStore,
  key: string,
  value: unknown,
): boolean {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Clamp a number into an inclusive range; returns `min` when NaN. */
export function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** A type guard for a finite number, handy as a `validate` argument. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A type guard for a non-empty string. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Builds a type guard that accepts only values from a fixed allow-list. */
export function isOneOf<T extends string>(
  allowed: readonly T[],
): (value: unknown) => value is T {
  return (value: unknown): value is T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
