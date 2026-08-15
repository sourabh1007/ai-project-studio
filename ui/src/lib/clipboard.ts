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
