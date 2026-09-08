/**
 * Pure, DOM-free model for the user-customizable appearance of the IDE. This is
 * the single source of truth that turns a small set of human choices (accent
 * colour, text size, density, corner radius, motion, font) into the concrete
 * CSS custom-property overrides applied to `<html>` at runtime.
 *
 * Keeping it pure means the whole "fully customizable UI" surface is unit-tested
 * to 100% without a DOM, and the exact same derivation runs in the React hook,
 * the Settings preview, and the pre-paint bootstrap.
 *
 * Overrides are applied as inline custom properties on the document element, so
 * they win over the stylesheet `:root`/theme values without touching any
 * feature CSS — every token already flows through these variables.
 */

import type { ResolvedTheme } from './theme.js';
import { isOneOf } from './persisted-state.js';

export type AccentKey =
  | 'indigo'
  | 'blue'
  | 'violet'
  | 'teal'
  | 'emerald'
  | 'rose'
  | 'amber';
export type TextSize = 'small' | 'default' | 'large' | 'x-large';
export type Density = 'compact' | 'cozy' | 'comfortable';
export type Radius = 'sharp' | 'soft' | 'round';
export type Motion = 'full' | 'reduced' | 'off';
export type FontChoice = 'system' | 'rounded' | 'reading' | 'mono-ui';

export interface UiPreferences {
  accent: AccentKey;
  textSize: TextSize;
  density: Density;
  radius: Radius;
  motion: Motion;
  font: FontChoice;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  accent: 'indigo',
  textSize: 'default',
  density: 'cozy',
  radius: 'soft',
  motion: 'full',
  font: 'system',
};

export const ACCENT_KEYS: readonly AccentKey[] = [
  'indigo',
  'blue',
  'violet',
  'teal',
  'emerald',
  'rose',
  'amber',
];
export const TEXT_SIZES: readonly TextSize[] = [
  'small',
  'default',
  'large',
  'x-large',
];
export const DENSITIES: readonly Density[] = ['compact', 'cozy', 'comfortable'];
export const RADII: readonly Radius[] = ['sharp', 'soft', 'round'];
export const MOTIONS: readonly Motion[] = ['full', 'reduced', 'off'];
export const FONTS: readonly FontChoice[] = [
  'system',
  'rounded',
  'reading',
  'mono-ui',
];

/** Per-accent light/dark hue + the text colour that reads on top of it. */
const ACCENTS: Record<
  AccentKey,
  { light: string; dark: string; onLight: string; onDark: string }
> = {
  indigo: { light: '#4f46e5', dark: '#818cf8', onLight: '#ffffff', onDark: '#0b1020' },
  blue: { light: '#2563eb', dark: '#60a5fa', onLight: '#ffffff', onDark: '#08111f' },
  violet: { light: '#7c3aed', dark: '#a78bfa', onLight: '#ffffff', onDark: '#140a24' },
  teal: { light: '#0f766e', dark: '#2dd4bf', onLight: '#ffffff', onDark: '#04201d' },
  emerald: { light: '#047857', dark: '#34d399', onLight: '#ffffff', onDark: '#04231a' },
  rose: { light: '#e11d48', dark: '#fb7185', onLight: '#ffffff', onDark: '#2a0912' },
  amber: { light: '#b45309', dark: '#fbbf24', onLight: '#ffffff', onDark: '#241704' },
};

/** Base type ramp (px). Multiplied by the text-size factor. */
const BASE_TYPE = {
  '--fs-page-title': 18,
  '--lh-page-title': 24,
  '--fs-section': 14,
  '--lh-section': 20,
  '--fs-card-title': 13,
  '--lh-card-title': 18,
  '--fs-body': 13,
  '--lh-body': 18,
  '--fs-secondary': 12,
  '--lh-secondary': 16,
  '--fs-meta': 11,
  '--lh-meta': 14,
} as const;

const TEXT_FACTOR: Record<TextSize, number> = {
  small: 0.92,
  default: 1,
  large: 1.1,
  'x-large': 1.2,
};

/** Base 8px spacing ramp (px). Multiplied by the density factor. */
const BASE_SPACE = {
  '--space-1': 4,
  '--space-2': 8,
  '--space-3': 12,
  '--space-4': 16,
  '--space-5': 24,
  '--space-6': 32,
  '--space-7': 48,
} as const;

const DENSITY_FACTOR: Record<Density, number> = {
  compact: 0.82,
  cozy: 1,
  comfortable: 1.18,
};

const CONTROL_HEIGHT: Record<Density, { base: number; sm: number }> = {
  compact: { base: 28, sm: 24 },
  cozy: { base: 32, sm: 28 },
  comfortable: { base: 38, sm: 32 },
};

const RADIUS_MAP: Record<Radius, { sm: number; md: number; lg: number }> = {
  sharp: { sm: 2, md: 3, lg: 4 },
  soft: { sm: 4, md: 8, lg: 10 },
  round: { sm: 8, md: 14, lg: 20 },
};

const FONT_STACK: Record<FontChoice, string> = {
  system: "'Segoe UI', system-ui, -apple-system, sans-serif",
  rounded:
    "'Segoe UI Variable', 'Nunito', 'Quicksand', 'Segoe UI', system-ui, sans-serif",
  reading: "'Georgia', 'Cambria', 'Iowan Old Style', 'Times New Roman', serif",
  'mono-ui': "'Cascadia Code', 'Consolas', ui-monospace, monospace",
};

/**
 * Premium motion durations/easings. `full` is the crafted default; `reduced`
 * shortens everything for users who want snappier, calmer transitions; `off`
 * effectively disables motion.
 */
const MOTION_MAP: Record<
  Motion,
  { fast: string; med: string; slow: string; ease: string }
> = {
  full: {
    fast: '140ms cubic-bezier(0.22, 1, 0.36, 1)',
    med: '240ms cubic-bezier(0.22, 1, 0.36, 1)',
    slow: '420ms cubic-bezier(0.22, 1, 0.36, 1)',
    ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
  },
  reduced: {
    fast: '90ms ease-out',
    med: '120ms ease-out',
    slow: '160ms ease-out',
    ease: 'ease-out',
  },
  off: {
    fast: '1ms linear',
    med: '1ms linear',
    slow: '1ms linear',
    ease: 'linear',
  },
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A type guard for a persisted, possibly-partial preferences object. */
export function normalizeUiPreferences(value: unknown): UiPreferences {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const pick = <T extends string>(
    v: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T => (isOneOf(allowed)(v) ? v : fallback);
  return {
    accent: pick(raw.accent, ACCENT_KEYS, DEFAULT_UI_PREFERENCES.accent),
    textSize: pick(raw.textSize, TEXT_SIZES, DEFAULT_UI_PREFERENCES.textSize),
    density: pick(raw.density, DENSITIES, DEFAULT_UI_PREFERENCES.density),
    radius: pick(raw.radius, RADII, DEFAULT_UI_PREFERENCES.radius),
    motion: pick(raw.motion, MOTIONS, DEFAULT_UI_PREFERENCES.motion),
    font: pick(raw.font, FONTS, DEFAULT_UI_PREFERENCES.font),
  };
}

/** The accent swatch (for previews/pickers) for a given key and theme. */
export function accentColor(accent: AccentKey, theme: ResolvedTheme): string {
  return ACCENTS[accent][theme];
}

/**
 * Derive the full set of CSS custom-property overrides for a preference set and
 * the currently-resolved theme. The returned map is applied verbatim onto
 * `document.documentElement.style`.
 */
export function deriveCssVariables(
  prefs: UiPreferences,
  theme: ResolvedTheme,
): Record<string, string> {
  const vars: Record<string, string> = {};

  // Accent + readable contrast colour.
  const accent = ACCENTS[prefs.accent];
  vars['--accent'] = theme === 'dark' ? accent.dark : accent.light;
  vars['--accent-contrast'] = theme === 'dark' ? accent.onDark : accent.onLight;

  // Type ramp.
  const tf = TEXT_FACTOR[prefs.textSize];
  for (const [name, base] of Object.entries(BASE_TYPE)) {
    vars[name] = `${round(base * tf)}px`;
  }

  // Spacing + control sizing.
  const df = DENSITY_FACTOR[prefs.density];
  for (const [name, base] of Object.entries(BASE_SPACE)) {
    vars[name] = `${round(base * df)}px`;
  }
  const ch = CONTROL_HEIGHT[prefs.density];
  vars['--control-height'] = `${ch.base}px`;
  vars['--control-height-sm'] = `${ch.sm}px`;

  // Corner radius.
  const r = RADIUS_MAP[prefs.radius];
  vars['--radius-sm'] = `${r.sm}px`;
  vars['--radius-md'] = `${r.md}px`;
  vars['--radius-lg'] = `${r.lg}px`;

  // Font family.
  vars['--font-sans'] = FONT_STACK[prefs.font];

  // Motion.
  const m = MOTION_MAP[prefs.motion];
  vars['--transition-fast'] = m.fast;
  vars['--transition-med'] = m.med;
  vars['--transition-slow'] = m.slow;
  vars['--ease-out'] = m.ease;

  return vars;
}

/** Short human labels for the preference options (for the settings UI). */
export function optionLabel(value: string): string {
  const map: Record<string, string> = {
    'x-large': 'Extra large',
    'mono-ui': 'Monospace',
  };
  return (
    map[value] ??
    value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ')
  );
}
