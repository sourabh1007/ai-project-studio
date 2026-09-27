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
  css = css.replace(/\r\n/g, '\n');
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

  it('exempts essential progress indicators from the reduced-motion kill switch', () => {
    // Spinners and the review "in progress" dot stay animated under both the
    // app-level reduced preference and OS reduced motion.
    expect(DESIGN_TOKENS_CSS).toContain(":root[data-motion='reduced'] .spinner");
    expect(DESIGN_TOKENS_CSS).toContain(
      "animation: spin 0.7s linear infinite !important;",
    );
    expect(DESIGN_TOKENS_CSS).toContain(
      "animation: rb-reviewing-pulse 1.2s ease-in-out infinite !important;",
    );
    // The explicit "off" choice is still honoured in full — no exemption.
    expect(DESIGN_TOKENS_CSS).not.toContain(":root[data-motion='off'] .spinner");
  });

  it('keeps primary button hover/active states free of color filters', () => {
    expect(cssBlock(APP_CSS, '.btn-primary:hover')).not.toContain('filter:');
    expect(cssBlock(APP_CSS, '.btn:active')).toContain('transform: none;');
  });
});

describe('shared desktop stylesheet', () => {
  it('uses compact font and control tokens without overriding user font choices', () => {
    expect(DESIGN_TOKENS_CSS).toContain('--fs-body: 12px;');
    expect(DESIGN_TOKENS_CSS).toContain('--fs-meta: 11px;');
    expect(DESIGN_TOKENS_CSS).toContain('--control-height: 28px;');
    expect(DESIGN_TOKENS_CSS).toContain('--control-height-sm: 24px;');
    expect(DESIGN_TOKENS_CSS).toContain('--tree-font: var(--fs-secondary);');
    expect(APP_CSS).toContain('var(--tree-font)/var(--lh-secondary) var(--font-sans)');
    expect(cssBlock(APP_CSS, '.input,\n.select')).toContain('padding: 3px var(--space-2);');
  });

  it.each(["[data-theme='light']", "[data-theme='dark']"])('keeps %s text readable on neutral surfaces', (theme) => {
    const block = cssBlock(DESIGN_TOKENS_CSS, theme);
    const token = (name: string) => {
      const match = block.match(new RegExp(`--${name}: (#[a-f0-9]{6});`));
      if (!match) throw new Error(`Missing ${name} in ${theme}`);
      return match[1];
    };
    for (const foreground of ['text', 'text-muted', 'text-faint', 'accent']) {
      for (const background of ['surface', 'surface-strong', 'panel-sidebar', 'tree-selected']) {
        expect(contrastRatio(token(foreground), token(background)), `${theme} ${foreground}/${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(token('accent'), token('accent-contrast'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('border-strong'), token('surface'))).toBeGreaterThanOrEqual(3);
    expect(block).toContain('--bg-gradient: none;');
  });

  it('uses flat shared surfaces with clear pane boundaries and a dialog-only shadow', () => {
    expect(cssBlock(APP_CSS, '.glass')).not.toContain('backdrop-filter');
    expect(cssBlock(APP_CSS, '.glass')).toContain('box-shadow: none;');
    expect(cssBlock(APP_CSS, '.icon-badge-ai')).not.toContain('gradient');
    expect(cssBlock(APP_CSS, '.modal {')).toContain('box-shadow: var(--shadow-dialog);');
    expect(cssBlock(APP_CSS, '.explorer {')).toContain('border-right: 1px solid var(--border-strong);');
    expect(cssBlock(APP_CSS, '.inspector {')).toContain('border-left: 1px solid var(--border-strong);');
    expect(cssBlock(APP_CSS, '.rb-nav-item.is-active')).toContain('box-shadow: inset 2px 0 var(--accent);');
  });

  it('keeps keyboard focus and high-contrast selections visible', () => {
    expect(DESIGN_TOKENS_CSS).toContain('summary:focus-visible');
    expect(DESIGN_TOKENS_CSS).toContain('[tabindex]:focus-visible');
    expect(DESIGN_TOKENS_CSS).toContain('outline: 2px solid var(--accent);');
    expect(cssBlock(DESIGN_TOKENS_CSS, '@media (forced-colors: active)')).toContain('outline: 1px solid Highlight;');
  });
});
