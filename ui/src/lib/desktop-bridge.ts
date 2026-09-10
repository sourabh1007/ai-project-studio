/**
 * The single source of truth for the Electron preload bridge (`window.desktop`,
 * see desktop/preload.cjs).
 *
 * Six call sites used to each declare their own private view of this object,
 * and several declared methods as *required*. That was never true: the bridge
 * is absent entirely in a browser, and an installed shell only exposes what its
 * own preload happened to ship. A required declaration turns a missing method
 * into an unchecked call and a runtime TypeError deep inside a render.
 *
 * So every capability here is optional, on purpose. Call sites must probe
 * before calling, and the compiler now enforces that.
 */

import type { ClipboardAttachmentResult, ClipboardResult } from './clipboard.js';
import type { ResolvedTheme } from './theme.js';
import type { UpdateSnapshot } from './update-state.js';

export interface RetainedImage {
  id: string;
  name: string;
  bytes: number;
  createdAt: string;
}

export interface RetainedImagesSnapshot {
  status: 'ready';
  items: RetainedImage[];
  totalBytes: number;
  limits: { files: number; totalBytes: number; fileBytes: number };
}

export interface AttachmentsBridge {
  list(): Promise<RetainedImagesSnapshot | { status: 'error'; error: string }>;
  remove(request: { ids: string[] }): Promise<
    | { status: 'deleted'; deleted: number }
    | { status: 'cancelled' }
    | { status: 'error'; error: string; deleted?: number }
  >;
}

export interface DesktopUpdatesBridge {
  getState?(): Promise<UpdateSnapshot>;
  check?(): Promise<UpdateSnapshot | void>;
  download?(): Promise<UpdateSnapshot | void>;
  install?(): Promise<boolean>;
  onEvent?(cb: (type: string, payload?: UpdateSnapshot) => void): () => void;
}

export interface DesktopBridge {
  setTheme?(mode: ResolvedTheme): void;
  revealFile?(path: string): void;
  openExternal?(url: string): void;
  copyText?(text: string): Promise<ClipboardResult>;
  clearClipboard?(): Promise<ClipboardResult>;
  runClipboardSmoke?(): Promise<unknown>;
  readText?(): Promise<string>;
  readImage?(request: { sessionId: string }): Promise<ClipboardAttachmentResult>;
  relaunch?(): Promise<boolean>;
  onBackendUnavailable?(
    cb: (detail: { reason?: string; stderrTail?: string }) => void,
  ): () => void;
  getVersion?(): Promise<string>;
  backendDiagnostics?(): Promise<unknown>;
  openDocs?(): void;
  attachments?: AttachmentsBridge;
  updates?: DesktopUpdatesBridge;
}

/**
 * Every capability this UI knows how to use, grouped by the namespace that
 * carries it. A contract test compares this against what preload.cjs actually
 * exposes, in both directions, so the two can never drift apart silently.
 */
export const DESKTOP_BRIDGE_CAPABILITIES = {
  root: [
    'attachments', 'backendDiagnostics', 'clearClipboard', 'copyText', 'getVersion',
    'onBackendUnavailable',
    'openDocs', 'openExternal', 'readImage', 'readText', 'relaunch', 'revealFile',
    'runClipboardSmoke', 'setTheme', 'updates',
  ],
  attachments: ['list', 'remove'],
  updates: ['check', 'download', 'getState', 'install', 'onEvent'],
} as const;

/** The namespaces above that are objects of methods rather than methods. */
export const DESKTOP_BRIDGE_NAMESPACES = ['attachments', 'updates'] as const;

function bridgeObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The live bridge, or undefined when running outside the desktop shell.
 * Never assume a property on the result exists.
 */
export function desktopBridge(): DesktopBridge | undefined {
  return bridgeObject((globalThis as { desktop?: unknown }).desktop) as
    | DesktopBridge
    | undefined;
}

/** The updates namespace, present only when this shell ships auto-update. */
export function desktopUpdatesBridge(): DesktopUpdatesBridge | undefined {
  return bridgeObject(desktopBridge()?.updates) as
    | DesktopUpdatesBridge
    | undefined;
}

/**
 * Which declared capabilities the given bridge does not provide, as dotted
 * names. An empty list means the shell satisfies everything this UI may call.
 * A missing namespace is reported as the namespace itself rather than as each
 * of its members, because the whole feature is simply absent.
 */
export function missingDesktopCapabilities(bridge: unknown): string[] {
  const root = bridgeObject(bridge);
  if (!root) return [...DESKTOP_BRIDGE_CAPABILITIES.root];
  const missing: string[] = [];
  for (const name of DESKTOP_BRIDGE_CAPABILITIES.root) {
    const value = root[name];
    const isNamespace = (DESKTOP_BRIDGE_NAMESPACES as readonly string[]).includes(name);
    const present = isNamespace ? bridgeObject(value) !== undefined : typeof value === 'function';
    if (!present) {
      missing.push(name);
      continue;
    }
    if (!isNamespace) continue;
    const members = DESKTOP_BRIDGE_CAPABILITIES[name as 'attachments' | 'updates'];
    const namespace = bridgeObject(value) as Record<string, unknown>;
    for (const member of members) {
      if (typeof namespace[member] !== 'function') missing.push(`${name}.${member}`);
    }
  }
  return missing;
}
