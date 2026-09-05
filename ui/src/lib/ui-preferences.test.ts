import { describe, expect, it } from 'vitest';
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
});

describe('accentColor + optionLabel', () => {
  it('returns the themed swatch', () => {
    expect(accentColor('emerald', 'light')).toBe('#059669');
    expect(accentColor('emerald', 'dark')).toBe('#34d399');
  });

  it('formats option labels, including special cases', () => {
    expect(optionLabel('x-large')).toBe('Extra large');
    expect(optionLabel('mono-ui')).toBe('Monospace');
    expect(optionLabel('compact')).toBe('Compact');
    expect(optionLabel('cozy')).toBe('Cozy');
  });
});
