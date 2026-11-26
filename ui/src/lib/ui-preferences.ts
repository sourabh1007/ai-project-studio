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
import {
  parseAccentValue,
  resolveAccent,
  type AccentValue,
} from './accent.js';
import {
  IDE_PALETTES,
  TERMINAL_SCHEMES,
  type IdePalette,
  type TerminalScheme,
} from './terminal-schemes.js';

export { IDE_PALETTES, TERMINAL_SCHEMES, type IdePalette, type TerminalScheme };

export {
  ACCENT_KEYS,
  accentSwatch,
  accentWasAdjusted,
  isAccentKey,
  parseAccentValue,
  resolveAccent,
  type AccentKey,
  type AccentValue,
} from './accent.js';

/**
 * The overall look of the IDE. `desktop` is the established compact,
 * enterprise appearance; `futuristic` is a "quiet sci-fi" surface treatment
 * (layered graphite in dark, crisp neutral in light) layered purely on the
 * colour/surface tokens via `data-appearance` on `<html>`. It is orthogonal to
 * density, radius and typography, which remain independently user-controlled.
 */
export type Appearance = 'desktop' | 'clarity' | 'futuristic';
export type TextSize = 'small' | 'default' | 'large' | 'x-large';
export type Density = 'compact' | 'cozy' | 'comfortable';
export type Radius = 'sharp' | 'soft' | 'round';
export type Motion = 'full' | 'reduced' | 'off';
export type FontChoice =
  | 'system'
  | 'inter'
  | 'rounded'
  | 'reading'
  | 'grotesk'
  | 'sci-fi'
  | 'hacker'
  | 'mono-ui';

/** Monospace family for the embedded session terminal and IDE code text. */
export type TerminalFont =
  | 'consolas'
  | 'jetbrains'
  | 'cascadia'
  | 'fira-code'
  | 'source-code'
  | 'ibm-plex'
  | 'ubuntu-mono'
  | 'victor-mono'
  | 'space-mono'
  | 'share-tech'
  | 'lucida'
  | 'vt323'
  | 'press-start';
export type TerminalTextSize = 'small' | 'default' | 'large' | 'x-large';
export type TerminalLineHeight = 'tight' | 'default' | 'relaxed';

export interface UiPreferences {
  appearance: Appearance;
  /** IDE surface color scheme, layered on the light/dark theme. */
  palette: IdePalette;
  accent: AccentValue;
  textSize: TextSize;
  density: Density;
  radius: Radius;
  motion: Motion;
  font: FontChoice;
  /** Monospace family for code, diffs and inline code across the IDE. */
  codeFont: TerminalFont;
  terminalFont: TerminalFont;
  terminalTextSize: TerminalTextSize;
  terminalLineHeight: TerminalLineHeight;
  terminalScheme: TerminalScheme;
  /** Terminal foreground: the sentinel `'theme'` or a `#rrggbb` override. */
  terminalTextColor: string;
  /** Planner quick-add: fix typos/acronyms as you type. */
  plannerAutocorrect: boolean;
  /** Planner quick-add: suggest previously used task titles. */
  plannerAutosuggest: boolean;
  /** Planner quick-add: tidy the title (trim/capitalize) when adding. */
  plannerAutoformat: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  appearance: 'desktop',
  palette: 'default',
  accent: 'blue',
  textSize: 'default',
  density: 'compact',
  radius: 'sharp',
  motion: 'full',
  font: 'system',
  codeFont: 'cascadia',
  terminalFont: 'consolas',
  terminalTextSize: 'default',
  terminalLineHeight: 'default',
  terminalScheme: 'auto',
  terminalTextColor: 'theme',
  plannerAutocorrect: true,
  plannerAutosuggest: true,
  plannerAutoformat: true,
};

export const APPEARANCES: readonly Appearance[] = ['desktop', 'clarity', 'futuristic'];
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
  'inter',
  'rounded',
  'reading',
  'grotesk',
  'sci-fi',
  'hacker',
  'mono-ui',
];

export const TERMINAL_FONTS: readonly TerminalFont[] = [
  'consolas',
  'jetbrains',
  'cascadia',
  'fira-code',
  'source-code',
  'ibm-plex',
  'ubuntu-mono',
  'victor-mono',
  'space-mono',
  'share-tech',
  'lucida',
  'vt323',
  'press-start',
];
export const TERMINAL_TEXT_SIZES: readonly TerminalTextSize[] = [
  'small',
  'default',
  'large',
  'x-large',
];
export const TERMINAL_LINE_HEIGHTS: readonly TerminalLineHeight[] = [
  'tight',
  'default',
  'relaxed',
];

/** Base type ramp (px). Multiplied by the text-size factor. */
const BASE_TYPE = {
  '--fs-page-title': 18,
  '--lh-page-title': 24,
  '--fs-section': 14,
  '--lh-section': 20,
  '--fs-card-title': 13,
  '--lh-card-title': 18,
  '--fs-body': 12,
  '--lh-body': 16,
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
  inter: "'Inter Variable', 'Inter', 'Segoe UI', system-ui, sans-serif",
  rounded:
    "'Segoe UI Variable', 'Nunito', 'Quicksand', 'Segoe UI', system-ui, sans-serif",
  reading: "'Georgia', 'Cambria', 'Iowan Old Style', 'Times New Roman', serif",
  grotesk: "'Space Grotesk Variable', 'Space Grotesk', 'Segoe UI', sans-serif",
  'sci-fi': "'Chakra Petch', 'Segoe UI', system-ui, sans-serif",
  hacker: "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  'mono-ui': "'Cascadia Code', 'Consolas', ui-monospace, monospace",
};

/** Monospace stacks offered for the session terminal and IDE code text. */
const TERMINAL_FONT_STACK: Record<TerminalFont, string> = {
  consolas: "'Consolas', 'Cascadia Mono', 'Courier New', ui-monospace, monospace",
  jetbrains: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
  cascadia: "'Cascadia Code', Consolas, ui-monospace, monospace",
  'fira-code': "'Fira Code Variable', 'Fira Code', Consolas, ui-monospace, monospace",
  'source-code': "'Source Code Pro Variable', 'Source Code Pro', Consolas, ui-monospace, monospace",
  'ibm-plex': "'IBM Plex Mono', Consolas, ui-monospace, monospace",
  'ubuntu-mono': "'Ubuntu Mono', Consolas, ui-monospace, monospace",
  'victor-mono': "'Victor Mono Variable', 'Victor Mono', Consolas, monospace",
  'space-mono': "'Space Mono', Consolas, ui-monospace, monospace",
  'share-tech': "'Share Tech Mono', Consolas, ui-monospace, monospace",
  lucida: "'Lucida Console', 'Lucida Sans Typewriter', Consolas, monospace",
  vt323: "'VT323', Consolas, ui-monospace, monospace",
  'press-start': "'Press Start 2P', Consolas, ui-monospace, monospace",
};

/** Pixel fonts are drawn on unusual em-boxes; scale them to a comparable cell. */
const TERMINAL_FONT_SCALE: Partial<Record<TerminalFont, number>> = {
  vt323: 1.3,
  'ubuntu-mono': 1.1,
  'press-start': 0.75,
};

/** Terminal font size in px for each named step. */
const TERMINAL_FONT_PX: Record<TerminalTextSize, number> = {
  small: 12,
  default: 13,
  large: 15,
  'x-large': 17,
};

const TERMINAL_LINE_HEIGHT: Record<TerminalLineHeight, number> = {
  tight: 1,
  default: 1.2,
  relaxed: 1.4,
};

/** The CSS stack for a UI font choice (used for live previews). */
export function fontStack(font: FontChoice): string {
  return FONT_STACK[font];
}

/** The CSS stack for a monospace choice (used for live previews). */
export function monoFontStack(font: TerminalFont): string {
  return TERMINAL_FONT_STACK[font];
}

/** The primary family name, for explicitly requesting a bundled face load. */
export function primaryFontFamily(stack: string): string {
  return stack.split(',')[0]!.trim().replace(/^'|'$/g, '');
}

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

/** True for a `#rrggbb` hex color string. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Normalize a persisted terminal color to `'theme'` or a lowercase hex. */
function normalizeTerminalColor(value: unknown): string {
  if (isHexColor(value)) return value.toLowerCase();
  return DEFAULT_UI_PREFERENCES.terminalTextColor;
}

/** Normalize a persisted boolean, falling back to `fallback` when absent. */
function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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
    appearance: pick(
      raw.appearance,
      APPEARANCES,
      DEFAULT_UI_PREFERENCES.appearance,
    ),
    palette: pick(raw.palette, IDE_PALETTES, DEFAULT_UI_PREFERENCES.palette),
    accent:
      parseAccentValue(raw.accent) ?? DEFAULT_UI_PREFERENCES.accent,
    textSize: pick(raw.textSize, TEXT_SIZES, DEFAULT_UI_PREFERENCES.textSize),
    density: pick(raw.density, DENSITIES, DEFAULT_UI_PREFERENCES.density),
    radius: pick(raw.radius, RADII, DEFAULT_UI_PREFERENCES.radius),
    motion: pick(raw.motion, MOTIONS, DEFAULT_UI_PREFERENCES.motion),
    font: pick(raw.font, FONTS, DEFAULT_UI_PREFERENCES.font),
    codeFont: pick(raw.codeFont, TERMINAL_FONTS, DEFAULT_UI_PREFERENCES.codeFont),
    terminalFont: pick(
      raw.terminalFont,
      TERMINAL_FONTS,
      DEFAULT_UI_PREFERENCES.terminalFont,
    ),
    terminalTextSize: pick(
      raw.terminalTextSize,
      TERMINAL_TEXT_SIZES,
      DEFAULT_UI_PREFERENCES.terminalTextSize,
    ),
    terminalLineHeight: pick(
      raw.terminalLineHeight,
      TERMINAL_LINE_HEIGHTS,
      DEFAULT_UI_PREFERENCES.terminalLineHeight,
    ),
    terminalScheme: pick(
      raw.terminalScheme,
      TERMINAL_SCHEMES,
      DEFAULT_UI_PREFERENCES.terminalScheme,
    ),
    terminalTextColor: normalizeTerminalColor(raw.terminalTextColor),
    plannerAutocorrect: pickBool(
      raw.plannerAutocorrect,
      DEFAULT_UI_PREFERENCES.plannerAutocorrect,
    ),
    plannerAutosuggest: pickBool(
      raw.plannerAutosuggest,
      DEFAULT_UI_PREFERENCES.plannerAutosuggest,
    ),
    plannerAutoformat: pickBool(
      raw.plannerAutoformat,
      DEFAULT_UI_PREFERENCES.plannerAutoformat,
    ),
  };
}

/** Resolved terminal appearance the xterm instance consumes. */
export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** A `#rrggbb` foreground override, or `null` to keep the theme default. */
  foreground: string | null;
  scheme: TerminalScheme;
  palette: IdePalette;
}

/** Derive the concrete terminal appearance from the user's preferences. */
export function terminalAppearance(prefs: UiPreferences): TerminalAppearance {
  const scale = TERMINAL_FONT_SCALE[prefs.terminalFont] ?? 1;
  return {
    fontFamily: TERMINAL_FONT_STACK[prefs.terminalFont],
    fontSize: Math.round(TERMINAL_FONT_PX[prefs.terminalTextSize] * scale),
    lineHeight: TERMINAL_LINE_HEIGHT[prefs.terminalLineHeight],
    foreground:
      prefs.terminalTextColor === 'theme' ? null : prefs.terminalTextColor,
    scheme: prefs.terminalScheme,
    palette: prefs.palette,
  };
}

/** The accent swatch (for previews/pickers) for a given value and theme. */
export function accentColor(accent: AccentValue, theme: ResolvedTheme): string {
  return resolveAccent(accent, theme).color;
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
  const accent = resolveAccent(prefs.accent, theme);
  vars['--accent'] = accent.color;
  vars['--accent-contrast'] = accent.contrast;

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
  vars['--font-mono'] = TERMINAL_FONT_STACK[prefs.codeFont];

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
    desktop: 'Compact desktop',
    futuristic: 'Futuristic',
    'x-large': 'Extra large',
    'mono-ui': 'Cascadia (mono)',
    inter: 'Inter',
    grotesk: 'Space Grotesk',
    'sci-fi': 'Chakra Petch (sci-fi)',
    hacker: 'JetBrains (hacker)',
    consolas: 'Consolas (Notepad style)',
    jetbrains: 'JetBrains Mono',
    cascadia: 'Cascadia Code',
    'fira-code': 'Fira Code',
    'source-code': 'Source Code Pro',
    'ibm-plex': 'IBM Plex Mono',
    'ubuntu-mono': 'Ubuntu Mono',
    'victor-mono': 'Victor Mono',
    'space-mono': 'Space Mono',
    'share-tech': 'Share Tech Mono',
    lucida: 'Lucida Console',
    vt323: 'VT323 (retro CRT)',
    'press-start': 'Press Start 2P (8-bit)',
    nord: 'Nord',
    dracula: 'Dracula',
    solarized: 'Solarized',
    gruvbox: 'Gruvbox',
    'tokyo-night': 'Tokyo Night',
    matrix: 'Matrix',
    cyberpunk: 'Cyberpunk',
  };
  return (
    map[value] ??
    value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ')
  );
}
