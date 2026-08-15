import { useEffect } from 'react';
import {
  classifyCopyCut,
  fieldSelectionText,
  type SelectableField,
} from '../lib/clipboard.js';

/** The subset of the Electron preload bridge this hook uses. */
interface DesktopClipboardBridge {
  copyText?: (text: string) => void;
}

function bridge(): DesktopClipboardBridge | undefined {
  return (window as unknown as { desktop?: DesktopClipboardBridge }).desktop;
}

/** True when the node is (inside) an xterm terminal, which owns its clipboard. */
function inTerminal(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('.xterm') !== null
  );
}

/** A focused input/textarea whose selection we can read, or null. */
function focusedField(): (SelectableField & { setRangeText?: unknown }) | null {
  const el = document.activeElement;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement
  ) {
    return el;
  }
  return null;
}

/** The text currently selected anywhere in the document. */
function currentSelectionText(): string {
  const field = focusedField();
  if (field) {
    const text = fieldSelectionText(field);
    if (text) {
      return text;
    }
  }
  return window.getSelection?.()?.toString() ?? '';
}

/** Writes text to the OS clipboard via the native bridge, with web fallbacks. */
function writeClipboard(text: string): void {
  const desktop = bridge();
  if (desktop?.copyText) {
    desktop.copyText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    return;
  }
  legacyCopy(text);
}

/** Synchronous clipboard write via a transient textarea (browser fallback). */
function legacyCopy(text: string): void {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  } catch {
    /* nothing else we can do */
  }
}

/**
 * App-wide clipboard hardening. The desktop app runs over a non-secure
 * `http://127.0.0.1` origin where `navigator.clipboard` is unavailable, so a
 * plain Ctrl/Cmd+C on selected UI text can silently fail — users then can't
 * copy paths, error messages, ids or summaries out into other applications.
 *
 * This capture-phase handler mirrors any copy/cut selection into the OS
 * clipboard through the reliable native Electron bridge (the same path the
 * terminal uses). It never calls `preventDefault`, so Chromium's own copy and
 * an input's native cut still run — writing the identical text is harmless and
 * simply guarantees the clipboard is populated. The terminal is skipped because
 * it fully manages its own copy-on-select and paste.
 */
export function useGlobalClipboard(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (classifyCopyCut(event) === null || inTerminal(event.target)) {
        return;
      }
      const text = currentSelectionText();
      if (text) {
        writeClipboard(text);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
