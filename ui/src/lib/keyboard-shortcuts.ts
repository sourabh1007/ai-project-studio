/**
 * Pure keyboard-shortcut model: a declarative binding list plus a deterministic
 * matcher and a display formatter. Kept free of React/DOM so it can be unit
 * tested to 100% and shared by the global handler and the shortcuts sheet.
 *
 * `ctrlOrMeta` treats Ctrl (Windows/Linux) and Cmd (macOS) as equivalent so a
 * single binding works cross-platform.
 */

/** The modifier + key combination that triggers a shortcut. */
export interface KeyChord {
  /** The `KeyboardEvent.key` value, compared case-insensitively (e.g. 'k'). */
  key: string;
  /** Requires Ctrl (or Cmd on macOS) to be held. */
  ctrlOrMeta?: boolean;
  /** Requires Shift to be held. */
  shift?: boolean;
  /** Requires Alt/Option to be held. */
  alt?: boolean;
}

/** A named, user-facing shortcut binding. */
export interface ShortcutBinding extends KeyChord {
  /** Stable id dispatched to the action handler. */
  id: string;
  /** Human-readable description shown in the shortcuts sheet. */
  title: string;
}

/** The minimal shape of a keyboard event the matcher needs. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Returns the first binding whose chord matches `event`, or `null` when none
 * do. Unspecified modifiers on a binding must be absent on the event, so
 * `Ctrl+K` does not fire for `Ctrl+Shift+K`.
 */
export function matchShortcut(
  event: KeyEventLike,
  bindings: readonly ShortcutBinding[],
): ShortcutBinding | null {
  const key = event.key.toLowerCase();
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  for (const binding of bindings) {
    if (
      binding.key.toLowerCase() === key &&
      Boolean(binding.ctrlOrMeta) === ctrlOrMeta &&
      Boolean(binding.shift) === event.shiftKey &&
      Boolean(binding.alt) === event.altKey
    ) {
      return binding;
    }
  }
  return null;
}

/** Formats a chord for display, e.g. `Ctrl+Shift+Tab`. */
export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrlOrMeta) parts.push('Ctrl');
  if (chord.shift) parts.push('Shift');
  if (chord.alt) parts.push('Alt');
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join('+');
}
