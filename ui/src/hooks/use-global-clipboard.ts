import { useEffect, useState } from 'react';
import { classifyCopyCut, fieldSelectionText, type ClipboardResult } from '../lib/clipboard.js';
import { copyText, CLIPBOARD_RESULT_EVENT } from './clipboard-write.js';

function ownsCopy(target: EventTarget | null): boolean {
  return !(target instanceof Element &&
    target.closest('.xterm, [data-clipboard-fallback]'));
}

function currentSelectionText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return fieldSelectionText(el);
  }
  return window.getSelection()?.toString() ?? '';
}

/**
 * Copy has one owner (including menu copy). Native cut stays with Chromium so
 * deletion and clipboard transfer remain one editing operation, not an async
 * write followed by deletion from a possibly different field.
 */
export function useGlobalClipboard(): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const copy = (event: Event) => {
      if (event.defaultPrevented || !ownsCopy(event.target)) return;
      const text = currentSelectionText();
      if (!text) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void copyText(text);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (classifyCopyCut(event) === 'copy') copy(event);
    };
    const onResult = (event: Event) => {
      const result = (event as CustomEvent<ClipboardResult>).detail;
      setError(result.ok ? null : `Copy failed (${result.error}). Clipboard contents may be unchanged; try again.`);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('copy', copy, true);
    window.addEventListener(CLIPBOARD_RESULT_EVENT, onResult);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('copy', copy, true);
      window.removeEventListener(CLIPBOARD_RESULT_EVENT, onResult);
    };
  }, []);
  return error;
}
