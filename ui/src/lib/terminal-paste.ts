export const INLINE_PASTE_BYTES = 4096;
export const MAX_TEXT_PASTE_BYTES = 4 * 1024 * 1024;
export const TEXT_PASTE_TIMEOUT_MS = 15_000;

export type TextPasteKind = 'inline' | 'file' | 'too-large';
export interface RetainedTextAttachment {
  attachmentId: string;
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}
export interface TextAttachmentsSnapshot {
  items: RetainedTextAttachment[];
  totalBytes: number;
  files: number;
  limits: { fileBytes: number; totalBytes: number; files: number };
}

export function classifyTextPaste(text: string): TextPasteKind {
  if (text.length > MAX_TEXT_PASTE_BYTES) return 'too-large';
  if (text.length > INLINE_PASTE_BYTES) return 'file';
  return new TextEncoder().encode(text).byteLength > INLINE_PASTE_BYTES ? 'file' : 'inline';
}

export function textPasteBody(text: string): Blob {
  if (text.length > MAX_TEXT_PASTE_BYTES) throw new Error('Pasted text exceeds the 4 MiB limit. Save it as a file and reference that file instead.');
  const body = new Blob([text], { type: 'text/plain;charset=utf-8' });
  if (body.size > MAX_TEXT_PASTE_BYTES) throw new Error('Pasted text exceeds the 4 MiB UTF-8 limit. Save it as a file and reference that file instead.');
  return body;
}

export function textPasteReference(result: unknown, sessionId: string, isWindows: boolean): string {
  if (!result || typeof result !== 'object' ||
      !('sessionId' in result) || result.sessionId !== sessionId ||
      !('path' in result) || typeof result.path !== 'string' ||
      !result.path || result.path.length > 4096 || /[\x00-\x1f\x7f]/.test(result.path) ||
      !(isWindows ? /^(?:[A-Za-z]:\\|\\\\)/.test(result.path) : result.path.startsWith('/'))) {
    throw new Error('The saved text attachment response was invalid. Nothing was pasted.');
  }
  const path = isWindows ? result.path.replace(/'/g, "''") : result.path.replace(/'/g, "'\"'\"'");
  const reference = `Read the full pasted text from the UTF-8 file '${path}'.`;
  if (classifyTextPaste(reference) !== 'inline') throw new Error('The saved text attachment reference was too long. Nothing was pasted.');
  return reference;
}
