/**
 * Pure helpers backing the app-wide clipboard hardening (see
 * `hooks/use-global-clipboard.ts`). Loopback HTTP origins such as
 * `http://127.0.0.1` are potentially trustworthy, but Clipboard API availability
 * still varies with browser/Electron permissions, focus and context. These
 * functions classify the chord
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

export type ClipboardResult =
  | { ok: true }
  | { ok: false; error: string; writeState: 'not-written' | 'unknown' | 'written' };

export type ClipboardAttachmentResult =
  | { status: 'none' }
  | { status: 'error'; error: string }
  | { status: 'ready'; source: 'clipboard-files'; paths: string[] }
  | { status: 'ready'; source: 'clipboard-image'; paths: [string]; attachmentId: string; sessionId: string };

/** Encode only at the terminal consumer, never in the privileged file owner. */
export function attachmentPasteText(result: ClipboardAttachmentResult, isWindows: boolean): string {
  if (result.status !== 'ready' || !Array.isArray(result.paths) || result.paths.length === 0 ||
      result.paths.length > 32 || result.paths.some((value) =>
        typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) {
    throw new Error('Invalid attachment response');
  }
  return result.paths.map((value) =>
    `'${isWindows ? value.replace(/'/g, "''") : value.replace(/'/g, "'\"'\"'")}'`).join(' ');
}

export function attachmentFailureMessage(error: string): string {
  if (error === 'quota') return 'Attachment storage is full. No attachment was pasted. Manage retained images in Settings → Diagnostics → Retained clipboard images. Manual deletion may break active, past, or resumed prompts. Automatic cleanup is not available.';
  if (error === 'image-too-large') return 'Clipboard image exceeds the attachment size limit. Resize it and paste again.';
  return 'Clipboard attachment could not be prepared. Nothing was pasted; check the clipboard and retry explicitly.';
}

export interface DesktopClipboardBridge {
  copyText?: (text: string) => Promise<ClipboardResult>;
  clearClipboard?: () => Promise<ClipboardResult>;
  readText?: () => Promise<string>;
  readImage?: (request: { sessionId: string }) => Promise<ClipboardAttachmentResult>;
}

export interface ClipboardWriters {
  native?: (text: string) => Promise<ClipboardResult>;
  browser?: (text: string) => Promise<ClipboardResult>;
  legacy: (text: string) => ClipboardResult;
  canFallback: () => boolean;
}

/** Only an explicit, pre-write availability failure permits another writer. */
export async function writeClipboardText(
  text: string,
  writers: ClipboardWriters,
): Promise<ClipboardResult> {
  if (!text) return { ok: false, error: 'empty-text', writeState: 'not-written' };
  const invoke = async (writer: (text: string) => ClipboardResult | Promise<ClipboardResult>): Promise<ClipboardResult> => {
    try {
      const result = await writer(text);
      if (!result || typeof result.ok !== 'boolean') {
        return { ok: false, error: 'invalid-acknowledgement', writeState: 'unknown' };
      }
      return result;
    } catch {
      return { ok: false, error: 'write-unacknowledged', writeState: 'unknown' };
    }
  };
  for (const writer of [writers.native, writers.browser]) {
    if (!writer) continue;
    const result = await invoke(writer);
    if (result.ok || result.writeState !== 'not-written' || result.error !== 'unavailable') {
      return result;
    }
    if (!writers.canFallback()) {
      return { ok: false, error: 'target-changed', writeState: 'not-written' };
    }
  }
  return invoke(writers.legacy);
}

/** Event identity, never text or timing, defines a paste operation. */
export function createPasteGuard() {
  const seen = new WeakSet<object>();
  return {
    shouldPaste(event: object) {
      if (seen.has(event)) return false;
      seen.add(event);
      return true;
    },
  };
}
