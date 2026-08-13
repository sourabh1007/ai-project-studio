/**
 * Pure, DOM-free theme logic — the single source of truth for how a stored
 * theme *preference* resolves to a concrete light/dark appearance. Kept free of
 * React/DOM so it can be unit tested to 100% and reused by the `useTheme` hook,
 * the pre-paint bootstrap in `index.html`, and the command palette toggle.
 *
 * A user picks a *preference* (`ThemeMode`): an explicit `light`/`dark`, or
 * `system` to follow the OS. That preference plus the current OS setting
 * resolves to the `ResolvedTheme` actually applied to `<html data-theme>`.
 */

/** What the user selects. `system` defers to the OS colour-scheme. */
export type ThemeMode = 'light' | 'dark' | 'system';

/** The concrete appearance applied to the document. */
export type ResolvedTheme = 'light' | 'dark';

/** Cycle order for a single toggle affordance: system → light → dark → system. */
const THEME_CYCLE: readonly ThemeMode[] = ['system', 'light', 'dark'];

/**
 * Normalises an untrusted stored value (e.g. from `localStorage`) into a valid
 * `ThemeMode`, falling back to `system` when the value is missing or unknown.
 */
export function parseThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system';
}

/**
 * Resolves a preference to a concrete appearance. `light`/`dark` are returned
 * as-is; `system` maps to `dark` when the OS prefers dark, else `light`.
 */
export function resolveTheme(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (mode === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return mode;
}

/**
 * The next preference when the user activates a single cycling toggle. Advances
 * system → light → dark → system. An unknown current value restarts the cycle.
 */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const index = THEME_CYCLE.indexOf(mode);
  return THEME_CYCLE[(index + 1) % THEME_CYCLE.length] as ThemeMode;
}

/** Short human label for a preference, for tooltips/status bar. */
export function themeModeLabel(mode: ThemeMode): string {
  return mode === 'system' ? 'System' : mode === 'dark' ? 'Dark' : 'Light';
}
