import { useSyncExternalStore } from 'react';
import { desktopBridge } from '../lib/desktop-bridge.js';

const listeners = new Set<() => void>();
const cached = new Map<string, string | null>();
let error: string | null = null;
let revision = 0;
let connected = false;

function emit() {
  revision += 1;
  listeners.forEach((listener) => listener());
}

function failure(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (error !== message) { error = message; emit(); }
}

export function readAppearance(key: string): string | null {
  if (cached.has(key)) return cached.get(key) ?? null;
  try {
    const bridge = desktopBridge();
    if (bridge?.getAppearance) {
      const saved = bridge.getAppearance();
      if (saved.error) throw new Error(saved.error);
      if (saved.values[key] !== undefined) {
        cached.set(key, saved.values[key]);
        return saved.values[key];
      }
      const legacy = window.localStorage.getItem(key);
      cached.set(key, legacy);
      if (legacy !== null) writeAppearance(key, legacy);
      return legacy;
    }
    const value = window.localStorage.getItem(key);
    cached.set(key, value);
    return value;
  } catch (cause) {
    cached.set(key, null);
    failure(cause);
    return null;
  }
}

export function writeAppearance(key: string, value: string): void {
  cached.set(key, value);
  try {
    const bridge = desktopBridge();
    if (bridge?.saveAppearance) {
      const result = bridge.saveAppearance(key, value);
      if (!result.saved) throw new Error(result.error ?? 'Appearance settings could not be saved.');
    } else {
      window.localStorage.setItem(key, value);
    }
    error = null;
    emit();
  } catch (cause) {
    failure(cause);
    emit();
  }
}

export function subscribeAppearance(listener: () => void) {
  if (!connected) {
    connected = true;
    window.addEventListener('storage', (event) => {
      if (event.key === 'cw-theme' || event.key === 'cw-ui-prefs') {
        cached.set(event.key, event.newValue);
        emit();
      }
    });
    desktopBridge()?.onAppearanceChanged?.((key, value) => {
      cached.set(key, value);
      emit();
    });
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppearanceRevision() {
  return useSyncExternalStore(subscribeAppearance, () => revision);
}

export function useAppearanceSaveError() {
  return useSyncExternalStore(subscribeAppearance, () => error);
}
