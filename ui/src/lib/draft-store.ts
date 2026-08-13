/**
 * Pure model for auto-saved editor drafts (Phase 4f).
 *
 * Long-form editors (shared context, prompts) can lose unsaved text on reload or
 * a crash. This module defines a tiny serialisable draft envelope plus the pure
 * decisions around it — validation, dirty detection, and what to show when a
 * persisted draft is found next to the last-saved ("base") value. Keeping the
 * logic pure makes it fully unit-testable; the `useDraft` hook supplies storage
 * and React state.
 */

export interface Draft {
  /** The unsaved editor text. */
  readonly value: string;
  /** ISO timestamp of when the draft was last auto-saved. */
  readonly savedAt: string;
}

/** Type guard for a persisted draft (used to validate untrusted storage JSON). */
export function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.value === 'string' && typeof record.savedAt === 'string'
  );
}

/** Type guard accepting either a draft or an explicit empty slot (`null`). */
export function isDraftOrNull(value: unknown): value is Draft | null {
  return value === null || isDraft(value);
}

/** Builds a draft envelope stamped with the given time. */
export function makeDraft(value: string, now: string): Draft {
  return { value, savedAt: now };
}

/** Whether the working `value` diverges from the last-saved `base`. */
export function isDirty(value: string, base: string): boolean {
  return value !== base;
}

/** The outcome of reconciling a persisted draft with the saved base value. */
export interface DraftResolution {
  /** The text the editor should show. */
  readonly value: string;
  /** True when a newer unsaved draft was restored over the base. */
  readonly restored: boolean;
}

/**
 * Decide what to load: a persisted draft wins only when it actually differs from
 * the saved base (otherwise it is stale/redundant and the base is used). This is
 * what lets the UI surface a one-time "unsaved draft restored" affordance without
 * nagging when the draft matches what was already saved.
 */
export function resolveDraft(
  draft: Draft | null,
  base: string,
): DraftResolution {
  if (draft && draft.value !== base) {
    return { value: draft.value, restored: true };
  }
  return { value: base, restored: false };
}
