import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, type ResolvedTheme } from './theme.js';
import {
  ACCENT_KEYS,
  DEFAULT_UI_PREFERENCES,
  DENSITIES,
  FONTS,
  MOTIONS,
  RADII,
  TEXT_SIZES,
  accentColor,
  deriveCssVariables,
  normalizeUiPreferences,
  optionLabel,
} from './ui-preferences.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_CSS = readFileSync(join(HERE, '..', 'styles', 'app.css'), 'utf8');
const DESIGN_TOKENS_CSS = readFileSync(
  join(HERE, '..', 'styles', 'design-tokens.css'),
  'utf8',
);

function cssBlock(css: string, marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) {
    throw new Error(`Missing CSS marker: ${marker}`);
  }
  const blockStart = css.indexOf('{', start);
  if (blockStart < 0) {
    throw new Error(`Missing opening brace for: ${marker}`);
  }
  let depth = 1;
  let index = blockStart + 1;
  while (depth > 0 && index < css.length) {
    const char = css[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    index += 1;
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced CSS block for: ${marker}`);
  }
  return css.slice(blockStart + 1, index - 1);
}

function themeBlock(theme: ResolvedTheme): string {
  const pattern =
    theme === 'light'
      ? /:root,\s*\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/
      : /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/;
  const match = DESIGN_TOKENS_CSS.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${theme} theme block`);
  }
  return match[1];
}

function themeToken(theme: ResolvedTheme, token: string): string {
  const match = themeBlock(theme).match(
    new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`),
  );
  if (!match) {
    throw new Error(`Could not find ${token} for ${theme}`);
  }
  return match[1];
}

function brightnessFactor(cssBlockText: string): number {
  const match = cssBlockText.match(/filter:\s*brightness\(([\d.]+)\)/);
  return match ? Number(match[1]) : 1;
}

function parseHexColor(color: string): [number, number, number] {
  const normalized = color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    return [
      Number.parseInt(normalized[1] + normalized[1], 16),
      Number.parseInt(normalized[2] + normalized[2], 16),
      Number.parseInt(normalized[3] + normalized[3], 16),
    ];
  }
  if (/^#[0-9a-f]{6}$/.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(1, 3), 16),
      Number.parseInt(normalized.slice(3, 5), 16),
      Number.parseInt(normalized.slice(5, 7), 16),
    ];
  }
  throw new Error(`Unsupported hex color: ${color}`);
}

function linearizeSrgb(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function applyBrightness(color: string, factor: number): [number, number, number] {
  return parseHexColor(color).map((channel) => Math.min(255, channel * factor)) as [
    number,
    number,
    number,
  ];
}

function contrastAfterBrightness(
  foreground: string,
  background: string,
  factor: number,
): number {
  const luminance = ([r, g, b]: [number, number, number]) =>
    0.2126 * linearizeSrgb(r) +
    0.7152 * linearizeSrgb(g) +
    0.0722 * linearizeSrgb(b);
  const fg = luminance(applyBrightness(foreground, factor));
  const bg = luminance(applyBrightness(background, factor));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

const BUTTON_HOVER_BLOCK = cssBlock(APP_CSS, '.btn-primary:hover');
const BUTTON_ACTIVE_BLOCK = cssBlock(APP_CSS, '.btn:active');

describe('normalizeUiPreferences', () => {
  it('returns defaults for missing/invalid input', () => {
    expect(normalizeUiPreferences(undefined)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences(null)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(normalizeUiPreferences('nope')).toEqual(DEFAULT_UI_PREFERENCES);
    expect(
      normalizeUiPreferences({ accent: 'bogus', textSize: 42, density: 'x' }),
    ).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it('keeps valid values and fills the rest with defaults', () => {
    const p = normalizeUiPreferences({ accent: 'teal', motion: 'off' });
    expect(p.accent).toBe('teal');
    expect(p.motion).toBe('off');
    expect(p.density).toBe(DEFAULT_UI_PREFERENCES.density);
  });
});

describe('deriveCssVariables', () => {
  it('applies the accent + readable contrast per theme', () => {
    const light = deriveCssVariables(
      { ...DEFAULT_UI_PREFERENCES, accent: 'rose' },
      'light',
    );
    const dark = deriveCssVariables(
      { ...DEFAULT_UI_PREFERENCES, accent: 'rose' },
      'dark',
    );
    expect(light['--accent']).toBe('#e11d48');
    expect(light['--accent-contrast']).toBe('#ffffff');
    expect(dark['--accent']).toBe('#fb7185');
    expect(dark['--accent']).not.toBe(light['--accent']);
  });

  it('scales the type ramp by text size', () => {
    const small = deriveCssVariables(
      { ...DEFAULT_UI_PREFERENCES, textSize: 'small' },
      'light',
    );
    const xl = deriveCssVariables(
      { ...DEFAULT_UI_PREFERENCES, textSize: 'x-large' },
      'light',
    );
    expect(small['--fs-body']).toBe('11.96px');
    expect(xl['--fs-body']).toBe('15.6px');
  });

  it('scales spacing + control height by density', () => {
    const compact = deriveCssVariables(
      { ...DEFAULT_UI_PREFERENCES, density: 'compact' },
      'light',
    );
    const roomy = deriveCssVariables(
      { ...DEFAULT_UI_PREFERENCES, density: 'comfortable' },
      'light',
    );
    expect(compact['--control-height']).toBe('28px');
    expect(roomy['--control-height']).toBe('38px');
    expect(compact['--space-4']).not.toBe(roomy['--space-4']);
  });

  it('maps radius, font and motion tokens', () => {
    const sharp = deriveCssVariables(
      { ...DEFAULT_UI_PREFERENCES, radius: 'sharp', font: 'reading', motion: 'off' },
      'light',
    );
    expect(sharp['--radius-md']).toBe('3px');
    expect(sharp['--font-sans']).toContain('Georgia');
    expect(sharp['--transition-fast']).toBe('1ms linear');
    expect(sharp['--ease-out']).toBe('linear');
  });

  it('produces a value for every option across all enums', () => {
    for (const accent of ACCENT_KEYS)
      for (const textSize of TEXT_SIZES)
        for (const density of DENSITIES)
          for (const radius of RADII)
            for (const motion of MOTIONS)
              for (const font of FONTS) {
                const v = deriveCssVariables(
                  { accent, textSize, density, radius, motion, font },
                  'dark',
                );
                expect(v['--accent']).toMatch(/^#/);
                expect(v['--font-sans'].length).toBeGreaterThan(0);
              }
  });

  it.each(['light', 'dark'] as const)(
    'keeps primary button text readable for every %s accent',
    (theme) => {
      for (const accent of ACCENT_KEYS) {
        const vars = deriveCssVariables(
          { ...DEFAULT_UI_PREFERENCES, accent },
          theme,
        );
        expect(
          contrastRatio(vars['--accent-contrast'], vars['--accent']),
          `${theme} ${accent} button contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each([
    { theme: 'light' as const, state: 'hover', factor: brightnessFactor(BUTTON_HOVER_BLOCK) },
    { theme: 'dark' as const, state: 'hover', factor: brightnessFactor(BUTTON_HOVER_BLOCK) },
    { theme: 'light' as const, state: 'active', factor: brightnessFactor(BUTTON_ACTIVE_BLOCK) },
    { theme: 'dark' as const, state: 'active', factor: brightnessFactor(BUTTON_ACTIVE_BLOCK) },
  ])(
    'keeps primary button text readable for every $theme accent in the $state state after visual effects',
    ({ theme, factor, state }) => {
      expect(BUTTON_HOVER_BLOCK).not.toMatch(/\b(background|color)\s*:/);
      expect(BUTTON_ACTIVE_BLOCK).not.toMatch(/\b(filter|background|color)\s*:/);
      for (const accent of ACCENT_KEYS) {
        const vars = deriveCssVariables(
          { ...DEFAULT_UI_PREFERENCES, accent },
          theme,
        );
        expect(
          contrastAfterBrightness(
            vars['--accent-contrast'],
            vars['--accent'],
            factor,
          ),
          `${theme} ${accent} ${state} button contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(['light', 'dark'] as const)(
    'keeps accent text readable on the %s panel surface for links and inline actions',
    (theme) => {
      const panel = themeToken(theme, '--panel');
      for (const accent of ACCENT_KEYS) {
        const vars = deriveCssVariables(
          { ...DEFAULT_UI_PREFERENCES, accent },
          theme,
        );
        expect(
          contrastRatio(vars['--accent'], panel),
          `${theme} ${accent} link contrast`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});

describe('accentColor + optionLabel', () => {
  it('returns the themed swatch', () => {
    expect(accentColor('emerald', 'light')).toBe('#047857');
    expect(accentColor('emerald', 'dark')).toBe('#34d399');
  });

  it('formats option labels, including special cases', () => {
    expect(optionLabel('x-large')).toBe('Extra large');
    expect(optionLabel('mono-ui')).toBe('Monospace');
    expect(optionLabel('compact')).toBe('Compact');
    expect(optionLabel('cozy')).toBe('Cozy');
  });
});
