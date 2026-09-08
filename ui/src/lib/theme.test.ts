import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  nextThemeMode,
  parseThemeMode,
  relativeLuminance,
  resolveTheme,
  themeModeLabel,
  type ThemeMode,
} from './theme.js';

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

describe('parseThemeMode', () => {
  it('accepts the three valid modes unchanged', () => {
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('dark')).toBe('dark');
    expect(parseThemeMode('system')).toBe('system');
  });

  it('falls back to system for missing or unknown values', () => {
    expect(parseThemeMode(null)).toBe('system');
    expect(parseThemeMode(undefined)).toBe('system');
    expect(parseThemeMode('')).toBe('system');
    expect(parseThemeMode('sepia')).toBe('system');
    expect(parseThemeMode(42)).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('returns explicit modes regardless of the OS setting', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('maps system to the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('nextThemeMode', () => {
  it('cycles system -> light -> dark -> system', () => {
    expect(nextThemeMode('system')).toBe('light');
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('system');
  });

  it('restarts the cycle from an unknown value', () => {
    expect(nextThemeMode('sepia' as ThemeMode)).toBe('system');
  });
});

describe('themeModeLabel', () => {
  it('labels every mode', () => {
    expect(themeModeLabel('system')).toBe('System');
    expect(themeModeLabel('dark')).toBe('Dark');
    expect(themeModeLabel('light')).toBe('Light');
  });
});

describe('WCAG color helpers', () => {
  it('calculates relative luminance for black and white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('calculates contrast ratios for 3-digit and 6-digit hex values', () => {
    expect(contrastRatio('#000', '#fff')).toBe(21);
    expect(contrastRatio('#fff', '#0f766e')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#fff', '#047857')).toBeGreaterThanOrEqual(4.5);
  });

  it('rejects unsupported hex colours', () => {
    expect(() => relativeLuminance('rgb(0, 0, 0)')).toThrow(
      'Unsupported hex color: rgb(0, 0, 0)',
    );
  });
});

describe('motion accessibility stylesheet policy', () => {
  it('disables animations for app motion reduced/off and OS reduced motion', () => {
    expect(DESIGN_TOKENS_CSS).toContain(":root[data-motion='reduced'] *");
    expect(DESIGN_TOKENS_CSS).toContain(":root[data-motion='off'] *");
    expect(DESIGN_TOKENS_CSS).toContain('animation: none !important;');
  });

  it('disables pseudo-element animation inside the OS reduced-motion media block', () => {
    const mediaBlock = cssBlock(
      DESIGN_TOKENS_CSS,
      '@media (prefers-reduced-motion: reduce)',
    );
    expect(mediaBlock).toContain('*::before');
    expect(mediaBlock).toContain('*::after');
    expect(mediaBlock).toContain('animation: none !important;');
  });

  it('does not force the top loading bar to keep animating under reduced motion', () => {
    expect(APP_CSS).not.toContain('animation-duration: 1.1s !important;');
    expect(APP_CSS).not.toContain('animation-duration: 1.6s !important;');
  });

  it('keeps primary button hover/active states free of color filters', () => {
    expect(cssBlock(APP_CSS, '.btn-primary:hover')).not.toContain('filter:');
    expect(APP_CSS).toMatch(/\.btn:active\s*\{\s*transform: translateY\(1px\);\s*\}/);
  });
});
