import { describe, expect, it } from 'vitest';
import {
  nextThemeMode,
  parseThemeMode,
  resolveTheme,
  themeModeLabel,
  type ThemeMode,
} from './theme.js';

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
