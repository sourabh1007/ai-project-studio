import { useEffect, useSyncExternalStore } from 'react';
import type { ResolvedTheme } from '../lib/theme.js';
import {
  readPersisted,
  writePersisted,
  type KeyValueStore,
} from '../lib/persisted-state.js';
import {
  DEFAULT_UI_PREFERENCES,
  deriveCssVariables,
  normalizeUiPreferences,
  type UiPreferences,
} from '../lib/ui-preferences.js';

const STORAGE_KEY = 'cw-ui-prefs';

function store(): KeyValueStore {
  return window.localStorage;
}

function load(): UiPreferences {
  return normalizeUiPreferences(
    readPersisted<unknown>(
      store(),
      STORAGE_KEY,
      (v): v is unknown => typeof v === 'object' && v !== null,
      DEFAULT_UI_PREFERENCES,
    ),
  );
}

// Module-level store so the applier (mounted once at the app root) and the
// Settings editor (lazy-loaded, deep in the tree) share one source of truth
// without threading a context through the code-split boundary.
let current: UiPreferences = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current preferences plus a persisting setter and a reset. */
export function useUiPreferences(): {
  prefs: UiPreferences;
  setPrefs: (next: Partial<UiPreferences>) => void;
  reset: () => void;
} {
  const prefs = useSyncExternalStore(subscribe, () => current);
  const setPrefs = (next: Partial<UiPreferences>): void => {
    current = normalizeUiPreferences({ ...current, ...next });
    writePersisted(store(), STORAGE_KEY, current);
    emit();
  };
  const reset = (): void => {
    current = { ...DEFAULT_UI_PREFERENCES };
    writePersisted(store(), STORAGE_KEY, current);
    emit();
  };
  return { prefs, setPrefs, reset };
}

/**
 * Applies the user's appearance preferences as inline CSS custom properties on
 * `<html>`, re-deriving whenever the preferences or the resolved theme change.
 * Mounted once at the app root.
 */
export function useApplyUiPreferences(theme: ResolvedTheme): void {
  const prefs = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    const root = document.documentElement;
    const vars = deriveCssVariables(prefs, theme);
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
    }
    root.setAttribute('data-motion', prefs.motion);
  }, [prefs, theme]);
}
