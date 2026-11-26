import { describe, expect, it } from 'vitest';
import {
  IDE_PALETTES,
  TERMINAL_SCHEMES,
  resolveTerminalScheme,
  terminalSchemeLabel,
  terminalSchemeMode,
  terminalTheme,
  type TerminalSchemeId,
} from './terminal-schemes.js';
import { contrastRatio } from './theme.js';

const EXPLICIT = TERMINAL_SCHEMES.filter((scheme): scheme is TerminalSchemeId => scheme !== 'auto');
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const BRIGHT = ['brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

describe('terminal color schemes', () => {
  it('defines a complete, readable palette for every scheme', () => {
    for (const id of EXPLICIT) {
      const theme = terminalTheme(id);
      for (const name of [...ANSI, ...BRIGHT]) {
        expect(theme[name], `${id} ${name}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(theme.cursorAccent).toBe(theme.background);
      expect(contrastRatio(theme.foreground!, theme.background!), `${id} default text`).toBeGreaterThanOrEqual(4.5);
      const dark = terminalSchemeMode(id) === 'dark';
      expect(contrastRatio(theme.background!, dark ? '#000000' : '#ffffff'), `${id} ${dark ? 'dark' : 'light'} background`)
        .toBeLessThan(dark ? 2 : 1.3);
      expect(terminalSchemeLabel(id).length).toBeGreaterThan(0);
    }
  });

  it('recolours only default text when a foreground override is set', () => {
    const base = terminalTheme('dracula');
    const custom = terminalTheme('dracula', '#ff8800');
    expect(custom).toEqual({ ...base, foreground: '#ff8800' });
    expect(terminalTheme('dracula', null)).toEqual(base);
    custom.red = '#000000';
    expect(terminalTheme('dracula').red).toBe('#ff5555');
  });

  it('follows the IDE palette and theme only when set to auto', () => {
    expect(resolveTerminalScheme('auto', 'default', 'dark')).toBe('studio-dark');
    expect(resolveTerminalScheme('auto', 'default', 'light')).toBe('studio-light');
    expect(resolveTerminalScheme('auto', 'solarized', 'light')).toBe('solarized-light');
    expect(resolveTerminalScheme('auto', 'gruvbox', 'dark')).toBe('gruvbox-dark');
    expect(resolveTerminalScheme('auto', 'nord', 'light')).toBe('studio-light');
    expect(resolveTerminalScheme('monokai', 'nord', 'light')).toBe('monokai');
    for (const palette of IDE_PALETTES) {
      for (const theme of ['light', 'dark'] as const) {
        expect(terminalSchemeMode(resolveTerminalScheme('auto', palette, theme))).toBe(theme);
      }
    }
    expect(terminalSchemeLabel('auto')).toBe('Match IDE');
  });
});
