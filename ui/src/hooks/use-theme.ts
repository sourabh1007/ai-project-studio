import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  nextThemeMode,
  parseThemeMode,
  resolveTheme,
  type ResolvedTheme,
  type ThemeMode,
} from '../lib/theme.js';

export type { ThemeMode, ResolvedTheme } from '../lib/theme.js';

const STORAGE_KEY = 'cw-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

interface DesktopBridge {
  setTheme(mode: ResolvedTheme): void;
}

function desktopBridge(): DesktopBridge | undefined {
  return (window as unknown as { desktop?: DesktopBridge }).desktop;
}

function initialMode(): ThemeMode {
  return parseThemeMode(window.localStorage.getItem(STORAGE_KEY));
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * Manages the theme *preference* (light/dark/**system**) as the single source
 * of truth, persists it, resolves it to a concrete appearance via
 * `lib/theme.ts`, reflects that on `<html data-theme>`, and re-resolves live
 * when the OS colour-scheme changes while the preference is `system`.
 */
export function useTheme(): {
  mode: ThemeMode;
  theme: ResolvedTheme;
  cycle: () => void;
  setMode: (mode: ThemeMode) => void;
} {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const sync = () => setPrefersDark(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const theme = useMemo(
    () => resolveTheme(mode, prefersDark),
    [mode, prefersDark],
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem(STORAGE_KEY, mode);
    desktopBridge()?.setTheme(theme);
  }, [mode, theme]);

  const cycle = useCallback(
    () => setMode((current) => nextThemeMode(current)),
    [],
  );

  return { mode, theme, cycle, setMode };
}
