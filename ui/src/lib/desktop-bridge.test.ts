import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  DESKTOP_BRIDGE_CAPABILITIES,
  DESKTOP_BRIDGE_NAMESPACES,
  desktopBridge,
  desktopUpdatesBridge,
  missingDesktopCapabilities,
} from './desktop-bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(here, '..', '..', '..', 'desktop', 'preload.cjs');

/** Runs the real production preload and returns what it hands the renderer. */
function exposedByRealPreload(): Record<string, unknown> {
  let exposed: Record<string, unknown> | undefined;
  const sandbox = {
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`unexpected require: ${id}`);
      return {
        contextBridge: {
          exposeInMainWorld(name: string, api: Record<string, unknown>) {
            expect(name).toBe('desktop');
            exposed = api;
          },
        },
        ipcRenderer: { send() {}, invoke: async () => undefined, on() {}, removeListener() {} },
      };
    },
    module: { exports: {} },
    URL,
  };
  vm.runInNewContext(readFileSync(preloadPath, 'utf8'), sandbox);
  if (!exposed) throw new Error('preload exposed nothing');
  return exposed;
}

function setBridge(value: unknown): void {
  (globalThis as { desktop?: unknown }).desktop = value;
}

afterEach(() => {
  delete (globalThis as { desktop?: unknown }).desktop;
});

describe('desktop bridge contract', () => {
  it('matches what the real preload exposes, with no drift in either direction', () => {
    const exposed = exposedByRealPreload();

    // Nothing the UI may call is missing from the shipped shell.
    expect(missingDesktopCapabilities(exposed)).toEqual([]);

    // ...and the shell ships nothing the contract has not declared, so a new
    // preload capability cannot be added without being declared here.
    expect(Object.keys(exposed).sort()).toEqual([...DESKTOP_BRIDGE_CAPABILITIES.root]);
    for (const namespace of DESKTOP_BRIDGE_NAMESPACES) {
      expect(Object.keys(exposed[namespace] as object).sort()).toEqual([
        ...DESKTOP_BRIDGE_CAPABILITIES[namespace],
      ]);
    }
  });

  it('reports every capability as missing when there is no shell at all', () => {
    expect(missingDesktopCapabilities(undefined)).toEqual([
      ...DESKTOP_BRIDGE_CAPABILITIES.root,
    ]);
    expect(missingDesktopCapabilities('desktop')).toEqual([
      ...DESKTOP_BRIDGE_CAPABILITIES.root,
    ]);
  });

  it('names an absent namespace once rather than listing each of its members', () => {
    const missing = missingDesktopCapabilities({});
    expect(missing).toContain('updates');
    expect(missing).not.toContain('updates.check');
  });

  it('reports individual members missing from a namespace an older shell ships', () => {
    const exposed = exposedByRealPreload();
    const older = { ...exposed, updates: { getState: () => {}, check: () => {} } };
    expect(missingDesktopCapabilities(older)).toEqual([
      'updates.download', 'updates.install', 'updates.onEvent',
    ]);
  });

  it('rejects non-callable capabilities rather than trusting the property name', () => {
    const exposed = exposedByRealPreload();
    expect(missingDesktopCapabilities({ ...exposed, relaunch: true })).toEqual(['relaunch']);
    expect(missingDesktopCapabilities({ ...exposed, attachments: () => {} })).toEqual([
      'attachments',
    ]);
  });
});

describe('desktopBridge accessors', () => {
  it('returns undefined outside the desktop shell', () => {
    expect(desktopBridge()).toBeUndefined();
    expect(desktopUpdatesBridge()).toBeUndefined();
  });

  it('ignores a non-object bridge instead of exposing it to call sites', () => {
    setBridge('not-a-bridge');
    expect(desktopBridge()).toBeUndefined();
    setBridge(null);
    expect(desktopBridge()).toBeUndefined();
  });

  it('returns the live bridge and its updates namespace', () => {
    const updates = { install: async () => true };
    setBridge({ relaunch: async () => true, updates });
    expect(desktopBridge()?.relaunch).toBeTypeOf('function');
    expect(desktopUpdatesBridge()).toBe(updates);
  });

  it('does not surface a non-object updates namespace', () => {
    setBridge({ updates: 'yes' });
    expect(desktopUpdatesBridge()).toBeUndefined();
  });
});
