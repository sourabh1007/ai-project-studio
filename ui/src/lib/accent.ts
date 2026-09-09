/**
 * Accent colour model — pure, DOM-free colour maths behind the fully
 * customizable accent.
 *
 * The user may pick *any* colour, but the IDE still has to stay readable: the
 * accent paints primary buttons (text sits on top of it) and inline links (it
 * sits on top of the panel). A freely chosen hue like pale yellow would fail
 * both. So a custom accent keeps the hue and saturation the user chose and only
 * its **lightness** is adapted until it clears the WCAG AA threshold against
 * the current theme's surfaces. The result still reads as "their colour", and
 * the accessibility guarantee that the preset swatches always had is preserved
 * for every possible pick.
 *
 * Presets resolve through a fixed hand-tuned table so the existing looks are
 * bit-for-bit unchanged.
 */

import { contrastRatio, type ResolvedTheme } from './theme.js';

export type AccentKey =
  | 'indigo'
  | 'blue'
  | 'violet'
  | 'teal'
  | 'emerald'
  | 'rose'
  | 'amber';

/** A preset key, or a custom `#rrggbb` colour chosen with the picker. */
export type AccentValue = AccentKey | string;

export const ACCENT_KEYS: readonly AccentKey[] = [
  'indigo',
  'blue',
  'violet',
  'teal',
  'emerald',
  'rose',
  'amber',
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

/**
 * The `--panel` surface an accent has to stay legible against. Mirrors
 * `design-tokens.css`; a test asserts the two never drift apart.
 */
export const ACCENT_SURFACE: Record<ResolvedTheme, string> = {
  light: '#ffffff',
  dark: '#171e33',
};

/** Candidate colours for text drawn on top of the accent. */
const ON_ACCENT: Record<ResolvedTheme, readonly string[]> = {
  light: ['#ffffff', '#10131c'],
  dark: ['#0b1020', '#ffffff'],
};

/** WCAG AA for normal text. */
export const MIN_ACCENT_CONTRAST = 4.5;

export interface ResolvedAccent {
  /** The colour applied to `--accent`. */
  color: string;
  /** The colour applied to `--accent-contrast`, readable on `color`. */
  contrast: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const HEX_SHORT = /^#[0-9a-f]{3}$/;
const HEX_LONG = /^#[0-9a-f]{6}$/;

/** Parses `#rgb`/`#rrggbb` (any case, surrounding space ok). `null` if invalid. */
export function parseHexColor(value: string): Rgb | null {
  const normalized = value.trim().toLowerCase();
  if (HEX_SHORT.test(normalized)) {
    return {
      r: Number.parseInt(normalized[1] + normalized[1], 16),
      g: Number.parseInt(normalized[2] + normalized[2], 16),
      b: Number.parseInt(normalized[3] + normalized[3], 16),
    };
  }
  if (HEX_LONG.test(normalized)) {
    return {
      r: Number.parseInt(normalized.slice(1, 3), 16),
      g: Number.parseInt(normalized.slice(3, 5), 16),
      b: Number.parseInt(normalized.slice(5, 7), 16),
    };
  }
  return null;
}

function channelHex(channel: number): string {
  return Math.round(channel).toString(16).padStart(2, '0');
}

/** Formats an RGB triple as `#rrggbb`. */
export function toHexColor({ r, g, b }: Rgb): string {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
}

/** sRGB → HSL, with hue in degrees and s/l as 0..1. */
export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) {
    return { h: 0, s: 0, l };
  }
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) {
    h = 60 * (((gn - bn) / delta + 6) % 6);
  } else if (max === gn) {
    h = 60 * ((bn - rn) / delta + 2);
  } else {
    h = 60 * ((rn - gn) / delta + 4);
  }
  return { h, s, l };
}

function hueChannel(p: number, q: number, offset: number): number {
  let t = offset;
  if (t < 0) {
    t += 1;
  }
  if (t > 1) {
    t -= 1;
  }
  if (t < 1 / 6) {
    return p + (q - p) * 6 * t;
  }
  if (t < 1 / 2) {
    return q;
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6;
  }
  return p;
}

/** HSL → sRGB, inverse of {@link rgbToHsl}. */
export function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const level = l * 255;
    return { r: level, g: level, b: level };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = ((h % 360) + 360) % 360 / 360;
  return {
    r: hueChannel(p, q, hn + 1 / 3) * 255,
    g: hueChannel(p, q, hn) * 255,
    b: hueChannel(p, q, hn - 1 / 3) * 255,
  };
}

/** True when `value` is a preset accent key. */
export function isAccentKey(value: unknown): value is AccentKey {
  return typeof value === 'string' && ACCENT_KEYS.includes(value as AccentKey);
}

/**
 * Coerces an untrusted stored/typed value into a usable accent: a preset key,
 * or a canonical lowercase `#rrggbb`. Returns `null` when it is neither, so
 * callers decide the fallback.
 */
export function parseAccentValue(value: unknown): AccentValue | null {
  if (isAccentKey(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const rgb = parseHexColor(value);
  return rgb === null ? null : toHexColor(rgb);
}

/** The best on-accent text colour for a candidate, and its contrast ratio. */
function bestOnAccent(
  color: string,
  theme: ResolvedTheme,
): { contrast: string; ratio: number } {
  return ON_ACCENT[theme]
    .map((candidate) => ({
      contrast: candidate,
      ratio: contrastRatio(candidate, color),
    }))
    .reduce((best, candidate) => (candidate.ratio > best.ratio ? candidate : best));
}

/**
 * Adapts a freely chosen colour to the theme: the hue and saturation are kept,
 * the lightness is moved as little as possible until the colour is legible both
 * *on* the panel and *under* its own button text.
 */
function adaptCustomAccent(hex: string, theme: ResolvedTheme): ResolvedAccent {
  const rgb = parseHexColor(hex) as Rgb;
  const { h, s, l } = rgbToHsl(rgb);
  const surface = ACCENT_SURFACE[theme];

  const scored = [
    // The exact colour the user picked, so a readable pick is never nudged by
    // the lightness quantisation below.
    { l: null as number | null },
    ...Array.from({ length: 101 }, (_unused, step) => ({ l: step / 100 })),
  ].map(({ l: candidateL }) => {
    const color =
      candidateL === null ? toHexColor(rgb) : toHexColor(hslToRgb({ h, s, l: candidateL }));
    const on = bestOnAccent(color, theme);
    const surfaceRatio = contrastRatio(color, surface);
    const readable =
      surfaceRatio >= MIN_ACCENT_CONTRAST && on.ratio >= MIN_ACCENT_CONTRAST;
    // A readable candidate always outranks an unreadable one; among readable
    // ones the closest to what the user actually picked wins.
    const score = readable
      ? 1000 - Math.abs((candidateL ?? l) - l)
      : Math.min(surfaceRatio, on.ratio);
    return { color, contrast: on.contrast, score };
  });

  const best = scored.reduce((winner, candidate) =>
    candidate.score > winner.score ? candidate : winner,
  );
  return { color: best.color, contrast: best.contrast };
}

/**
 * Resolves any accent value for a theme into the concrete `--accent` and
 * `--accent-contrast` pair.
 */
export function resolveAccent(
  accent: AccentValue,
  theme: ResolvedTheme,
): ResolvedAccent {
  if (isAccentKey(accent)) {
    const preset = ACCENTS[accent];
    return theme === 'dark'
      ? { color: preset.dark, contrast: preset.onDark }
      : { color: preset.light, contrast: preset.onLight };
  }
  return adaptCustomAccent(accent, theme);
}

/**
 * The colour to *show* for an accent in the picker. Presets show their themed
 * hue; a custom accent shows exactly what the user chose, so the swatch always
 * matches the value in the hex field even when the applied accent was adapted
 * for contrast.
 */
export function accentSwatch(accent: AccentValue, theme: ResolvedTheme): string {
  return isAccentKey(accent) ? resolveAccent(accent, theme).color : accent;
}

/**
 * True when a custom pick had to be adjusted to stay legible, so the UI can say
 * so instead of silently showing a different colour than the one chosen.
 */
export function accentWasAdjusted(
  accent: AccentValue,
  theme: ResolvedTheme,
): boolean {
  return !isAccentKey(accent) && resolveAccent(accent, theme).color !== accent;
}
