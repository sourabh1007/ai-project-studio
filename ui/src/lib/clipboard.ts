/**
 * Pure helpers backing the app-wide clipboard hardening (see
 * `hooks/use-global-clipboard.ts`). The desktop app is served over plain
 * `http://127.0.0.1`, which is not a secure context, so `navigator.clipboard`
 * is unavailable and a bare Ctrl+C on selected UI text (labels, paths, error
 * messages, summaries) can silently no-op — meaning users can't copy anything
 * out of the app into other applications. These functions classify the chord
 * and extract the selected text so the effectful hook can route it through the
 * native Electron clipboard bridge. Kept DOM-free so they are unit-tested to
 * 100%.
 */

/** The minimal shape of a keyboard event the classifier needs. */
export interface ClipboardKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** A copy or cut intent. */
export type ClipboardAction = 'copy' | 'cut';

/**
 * Classifies a keydown as a plain Ctrl/Cmd+C (copy) or Ctrl/Cmd+X (cut) chord,
 * or `null` for anything else. Shift and Alt must be absent so this never
 * shadows richer chords (e.g. the terminal's Ctrl+Shift+C). Case-insensitive.
 */
export function classifyCopyCut(
  event: ClipboardKeyEvent,
): ClipboardAction | null {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.shiftKey || event.altKey) {
    return null;
  }
  switch (event.key.toLowerCase()) {
    case 'c':
      return 'copy';
    case 'x':
      return 'cut';
    default:
      return null;
  }
}

/** The selectable subset of an `<input>` / `<textarea>` element. */
export interface SelectableField {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

/**
 * Returns the selected substring of a text field, or `''` when the selection is
 * empty or absent. Order-independent: a backwards selection (start > end) still
 * yields the correct slice.
 */
export function fieldSelectionText(field: SelectableField): string {
  const { value, selectionStart, selectionEnd } = field;
  if (
    selectionStart == null ||
    selectionEnd == null ||
    selectionStart === selectionEnd
  ) {
    return '';
  }
  const from = Math.min(selectionStart, selectionEnd);
  const to = Math.max(selectionStart, selectionEnd);
  return value.slice(from, to);
}

/**
 * Normalises copied terminal text. xterm selections can include frame/seam
 * pipes from the CLI's bordered, wrapped output; strip only those padded edge
 * artifacts while preserving real inline pipes. Then apply the host clipboard's
 * line-ending convention (CRLF on Windows, LF elsewhere) without doubling CRs.
 * Kept DOM-free (the caller passes the platform) so it unit-tests to 100%.
 */
export function toClipboardText(text: string, isWindows: boolean): string {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const withoutTrailingFrame = line.replace(/[ \t]{2,}[|│][ \t]*$/, '');
      return (withoutTrailingFrame === line
        ? line
        : withoutTrailingFrame.replace(/^[ \t]*[|│][ \t]?/, '')
      ).replace(/[ \t]{2,}[|│][ \t]{1,}/g, ' ');
    })
    .join('\n');
  return isWindows ? cleaned.replace(/\n/g, '\r\n') : cleaned;
}

/** Guards against the same paste being delivered more than once in a burst. */
export interface PasteGuard {
  /**
   * Returns true when this paste should be delivered, false when it duplicates
   * the immediately preceding paste of identical text inside the dedupe window.
   */
  shouldPaste(text: string, nowMs: number): boolean;
}

/**
 * Creates a paste de-duplicator. Some host/OS/webview combinations deliver a
 * single user paste as two events (e.g. an app-menu accelerator firing
 * alongside the native paste), which pastes everything twice in the terminal.
 * This collapses identical back-to-back pastes that arrive within `windowMs`
 * into one. The window is anchored to the first accepted paste (not refreshed by
 * the rejected duplicates), and any window well under human double-paste speed
 * (tens of ms) never suppresses a deliberate repeat. Pure and DOM-free.
 */
export function createPasteGuard(windowMs: number): PasteGuard {
  let lastText: string | null = null;
  let lastAt = 0;
  return {
    shouldPaste(text, nowMs) {
      if (lastText === text && nowMs - lastAt < windowMs) {
        return false;
      }
      lastText = text;
      lastAt = nowMs;
      return true;
    },
  };
}
