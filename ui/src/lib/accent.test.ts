import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, type ResolvedTheme } from './theme.js';
import {
  ACCENT_KEYS,
  ACCENT_SURFACE,
  MIN_ACCENT_CONTRAST,
  accentSwatch,
  accentWasAdjusted,
  hslToRgb,
  isAccentKey,
  parseAccentValue,
  parseHexColor,
  resolveAccent,
  rgbToHsl,
  toHexColor,
} from './accent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN_TOKENS_CSS = readFileSync(
  join(HERE, '..', 'styles', 'design-tokens.css'),
  'utf8',
);

const THEMES: readonly ResolvedTheme[] = ['light', 'dark'];

/** A wide spread of user picks: full hue circle at several saturations/levels. */
function sweepColors(): string[] {
  const colors: string[] = [];
  for (let hue = 0; hue < 360; hue += 5) {
    for (const s of [0, 0.15, 0.5, 0.85, 1]) {
      for (const l of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        colors.push(toHexColor(hslToRgb({ h: hue, s, l })));
      }
    }
  }
  return colors;
}

describe('hex parsing', () => {
  it('parses short and long hex in any case, with surrounding space', () => {
    expect(parseHexColor('#abc')).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseHexColor('  #AABBCC  ')).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('rejects anything that is not a hex colour', () => {
    for (const value of ['', 'abc', '#ab', '#abcd', 'rgb(1,2,3)', '#gggggg']) {
      expect(parseHexColor(value), value).toBeNull();
    }
  });

  it('round-trips through hex formatting', () => {
    expect(toHexColor({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(toHexColor({ r: 255, g: 255, b: 255 })).toBe('#ffffff');
    expect(toHexColor({ r: 79, g: 70, b: 229 })).toBe('#4f46e5');
  });
});

describe('rgb <-> hsl', () => {
  it('round-trips every swept colour', () => {
    for (const color of sweepColors()) {
      const rgb = parseHexColor(color);
      expect(rgb).not.toBeNull();
      const back = toHexColor(hslToRgb(rgbToHsl(rgb as { r: number; g: number; b: number })));
      expect(back, color).toBe(color);
    }
  });

  it('treats greys as achromatic', () => {
    const hsl = rgbToHsl({ r: 128, g: 128, b: 128 });
    expect(hsl.s).toBe(0);
    expect(hsl.h).toBe(0);
  });

  it('derives hue from whichever channel dominates', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 }).h).toBeCloseTo(0);
    expect(rgbToHsl({ r: 0, g: 255, b: 0 }).h).toBeCloseTo(120);
    expect(rgbToHsl({ r: 0, g: 0, b: 255 }).h).toBeCloseTo(240);
    // Red with a blue bias wraps past 360 back into range.
    expect(rgbToHsl({ r: 255, g: 0, b: 128 }).h).toBeGreaterThan(300);
  });

  it('normalises hue outside 0..360', () => {
    expect(toHexColor(hslToRgb({ h: 420, s: 1, l: 0.5 }))).toBe(
      toHexColor(hslToRgb({ h: 60, s: 1, l: 0.5 })),
    );
    expect(toHexColor(hslToRgb({ h: -60, s: 1, l: 0.5 }))).toBe(
      toHexColor(hslToRgb({ h: 300, s: 1, l: 0.5 })),
    );
  });
});

describe('parseAccentValue', () => {
  it('keeps preset keys as keys', () => {
    for (const key of ACCENT_KEYS) {
      expect(parseAccentValue(key)).toBe(key);
      expect(isAccentKey(key)).toBe(true);
    }
  });

  it('canonicalises custom colours to lowercase #rrggbb', () => {
    expect(parseAccentValue('#ABC')).toBe('#aabbcc');
    expect(parseAccentValue('#4F46E5')).toBe('#4f46e5');
  });

  it('rejects non-colours and non-strings', () => {
    for (const value of [undefined, null, 42, {}, [], 'bogus', '#12']) {
      expect(parseAccentValue(value)).toBeNull();
    }
    expect(isAccentKey(42)).toBe(false);
    expect(isAccentKey('bogus')).toBe(false);
  });
});

describe('accent surface tokens', () => {
  it.each(THEMES)('matches the --panel token in design-tokens.css for %s', (theme) => {
    const pattern =
      theme === 'light'
        ? /:root,\s*\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/
        : /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/;
    const block = DESIGN_TOKENS_CSS.match(pattern);
    expect(block, `${theme} theme block`).not.toBeNull();
    const panel = (block as RegExpMatchArray)[1].match(
      /--panel:\s*(#[0-9a-fA-F]{6})/,
    );
    expect(panel, `${theme} --panel`).not.toBeNull();
    expect((panel as RegExpMatchArray)[1].toLowerCase()).toBe(
      ACCENT_SURFACE[theme],
    );
  });
});

describe('resolveAccent', () => {
  it('returns the hand-tuned preset colours unchanged', () => {
    expect(resolveAccent('emerald', 'light')).toEqual({
      color: '#047857',
      contrast: '#ffffff',
    });
    expect(resolveAccent('emerald', 'dark')).toEqual({
      color: '#34d399',
      contrast: '#04231a',
    });
  });

  it.each(THEMES)(
    'keeps every custom colour readable on the %s panel and under its own text',
    (theme) => {
      const surface = ACCENT_SURFACE[theme];
      for (const color of sweepColors()) {
        const { color: applied, contrast } = resolveAccent(color, theme);
        expect(
          contrastRatio(applied, surface),
          `${color} on ${theme} panel`,
        ).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
        expect(
          contrastRatio(contrast, applied),
          `${color} button text in ${theme}`,
        ).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
      }
    },
  );

  it.each(THEMES)('preserves the chosen hue in %s', (theme) => {
    for (let hue = 0; hue < 360; hue += 15) {
      const chosen = toHexColor(hslToRgb({ h: hue, s: 0.85, l: 0.5 }));
      const applied = resolveAccent(chosen, theme).color;
      const appliedHue = rgbToHsl(
        parseHexColor(applied) as { r: number; g: number; b: number },
      ).h;
      const delta = Math.abs(((appliedHue - hue + 540) % 360) - 180);
      expect(delta, `hue drift for ${chosen} in ${theme}`).toBeLessThan(2);
    }
  });

  it('leaves an already-readable colour exactly as chosen', () => {
    expect(resolveAccent('#4f46e5', 'light').color).toBe('#4f46e5');
    expect(accentWasAdjusted('#4f46e5', 'light')).toBe(false);
  });

  it('adjusts a colour that would be illegible', () => {
    // Near-white yellow is invisible on the light panel; it must be darkened.
    expect(accentWasAdjusted('#fffbe0', 'light')).toBe(true);
    // Near-black is invisible on the dark panel; it must be lightened.
    expect(accentWasAdjusted('#05060a', 'dark')).toBe(true);
  });

  it('never reports a preset as adjusted', () => {
    for (const theme of THEMES) {
      for (const key of ACCENT_KEYS) {
        expect(accentWasAdjusted(key, theme)).toBe(false);
      }
    }
  });
});

describe('accentSwatch', () => {
  it('shows the themed colour for presets', () => {
    expect(accentSwatch('emerald', 'light')).toBe('#047857');
    expect(accentSwatch('emerald', 'dark')).toBe('#34d399');
  });

  it('shows exactly what the user chose for a custom accent', () => {
    expect(accentSwatch('#fffbe0', 'light')).toBe('#fffbe0');
  });
});
