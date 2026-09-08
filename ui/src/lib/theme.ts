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

function expandHexDigit(value: string): string {
  return value + value;
}

function parseHexChannel(value: string): number {
  return Number.parseInt(value, 16);
}

function parseHexColor(color: string): { r: number; g: number; b: number } {
  const normalized = color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return {
      r: parseHexChannel(expandHexDigit(normalized.slice(1, 2))),
      g: parseHexChannel(expandHexDigit(normalized.slice(2, 3))),
      b: parseHexChannel(expandHexDigit(normalized.slice(3, 4))),
    };
  }
  if (/^#[0-9a-f]{6}$/.test(normalized)) {
    return {
      r: parseHexChannel(normalized.slice(1, 3)),
      g: parseHexChannel(normalized.slice(3, 5)),
      b: parseHexChannel(normalized.slice(5, 7)),
    };
  }
  throw new Error(`Unsupported hex color: ${color}`);
}

function linearizeSrgb(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance for a hex sRGB colour. */
export function relativeLuminance(color: string): number {
  const { r, g, b } = parseHexColor(color);
  return (
    0.2126 * linearizeSrgb(r) +
    0.7152 * linearizeSrgb(g) +
    0.0722 * linearizeSrgb(b)
  );
}

/** WCAG 2.x contrast ratio between two hex sRGB colours. */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}
