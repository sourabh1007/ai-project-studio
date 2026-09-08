import {
  writeClipboardText,
  type ClipboardResult,
  type DesktopClipboardBridge,
} from '../lib/clipboard.js';

export const CLIPBOARD_RESULT_EVENT = 'studio:clipboard-result';

let internalFocusTransfer: { from: Element | null; to: HTMLElement } | null = null;

/** Only the synchronous transfer to our fallback textarea is internal. */
export function isInternalClipboardFocusTransfer(event: FocusEvent): boolean {
  return internalFocusTransfer !== null &&
    event.target === internalFocusTransfer.from &&
    event.relatedTarget === internalFocusTransfer.to;
}

/** Restores selection/focus even when the legacy API throws. */
function legacyCopy(text: string): ClipboardResult {
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const area = document.createElement('textarea');
  area.dataset.clipboardFallback = 'true';
  area.value = text;
  area.readOnly = true;
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  try {
    document.body.appendChild(area);
    const previousTransfer = internalFocusTransfer;
    internalFocusTransfer = { from: focused, to: area };
    try {
      area.focus();
    } finally {
      internalFocusTransfer = previousTransfer;
    }
    area.select();
    return document.execCommand('copy')
      ? { ok: true }
      : { ok: false, error: 'unavailable', writeState: 'not-written' };
  } catch {
    return { ok: false, error: 'legacy-write-failed', writeState: 'unknown' };
  } finally {
    area.remove();
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

export async function copyText(text: string): Promise<ClipboardResult> {
  const desktop = (window as unknown as { desktop?: DesktopClipboardBridge }).desktop;
  const target = document.activeElement;
  let targetChanged = false;
  const invalidate = () => { targetChanged = true; };
  document.addEventListener('focusin', invalidate);
  window.addEventListener('blur', invalidate);
  try {
    const result = await writeClipboardText(text, {
      native: desktop?.copyText ? (value) => desktop.copyText!(value) : undefined,
      browser: navigator.clipboard?.writeText ? async (value) => {
        try {
          await navigator.clipboard.writeText(value);
          return { ok: true };
        } catch (error) {
          if (error instanceof DOMException &&
              (error.name === 'NotAllowedError' || error.name === 'NotSupportedError')) {
            return { ok: false, error: 'unavailable', writeState: 'not-written' };
          }
          return { ok: false, error: 'browser-write-failed', writeState: 'unknown' };
        }
      } : undefined,
      legacy: legacyCopy,
      canFallback: () => !targetChanged && !!target?.isConnected &&
        document.activeElement === target,
    });
    // Diagnostics contain only the final outcome, never clipboard contents.
    window.dispatchEvent(new CustomEvent(CLIPBOARD_RESULT_EVENT, { detail: result }));
    return result;
  } finally {
    document.removeEventListener('focusin', invalidate);
    window.removeEventListener('blur', invalidate);
  }
}
