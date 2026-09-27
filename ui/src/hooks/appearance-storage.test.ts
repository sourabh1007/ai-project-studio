import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../lib/desktop-bridge.js';

afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); });

it('restores desktop appearance after origin storage is cleared and migrates legacy values once', async () => {
  const values: Record<string, string> = {};
  let changed: ((key: string, value: string) => void) | undefined;
  const bridge: DesktopBridge = {
    getAppearance: () => ({ values, error: null }),
    saveAppearance: vi.fn((key, value) => {
      values[key] = value;
      return { saved: true, error: null };
    }),
    onAppearanceChanged: (callback) => { changed = callback; return () => {}; },
  };
  vi.stubGlobal('desktop', bridge);
  vi.resetModules();
  const first = await import('./appearance-storage.js');
  window.localStorage.setItem('cw-theme', 'dark');
  expect(first.readAppearance('cw-theme')).toBe('dark');
  expect(bridge.saveAppearance).toHaveBeenCalledOnce();
  const prefs = JSON.stringify({ accent: '#123456', terminalFont: 'consolas', textSize: 'large' });
  first.writeAppearance('cw-ui-prefs', prefs);
  window.localStorage.clear();
  vi.resetModules();
  const restarted = await import('./appearance-storage.js');
  expect(restarted.readAppearance('cw-ui-prefs')).toBe(prefs);
  expect(restarted.readAppearance('cw-theme')).toBe('dark');
  const update = vi.fn();
  const stop = restarted.subscribeAppearance(update);
  changed?.('cw-theme', 'light');
  expect(restarted.readAppearance('cw-theme')).toBe('light');
  expect(update).toHaveBeenCalledOnce();
  stop();
});

it('keeps immediate changes when durable saving fails and does not silently substitute port storage', async () => {
  vi.stubGlobal('desktop', {
    getAppearance: () => ({ values: {}, error: null }),
    saveAppearance: () => ({ saved: false, error: 'Disk full' }),
  });
  vi.resetModules();
  const storage = await import('./appearance-storage.js');
  const notify = vi.fn();
  const stop = storage.subscribeAppearance(notify);
  storage.writeAppearance('cw-theme', 'light');
  expect(storage.readAppearance('cw-theme')).toBe('light');
  expect(window.localStorage.getItem('cw-theme')).toBeNull();
  expect(notify).toHaveBeenCalled();
  stop();
});

it('persists browser settings and observes storage updates from another window', async () => {
  vi.stubGlobal('desktop', undefined);
  vi.resetModules();
  const storage = await import('./appearance-storage.js');
  storage.writeAppearance('cw-theme', 'dark');
  expect(window.localStorage.getItem('cw-theme')).toBe('dark');
  const stop = storage.subscribeAppearance(vi.fn());
  window.dispatchEvent(new StorageEvent('storage', { key: 'cw-theme', newValue: 'system' }));
  expect(storage.readAppearance('cw-theme')).toBe('system');
  stop();
});
