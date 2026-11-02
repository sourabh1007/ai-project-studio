import { describe, expect, it, vi } from 'vitest';
import {
  classifyTextPaste, textPasteBody, textPasteReference,
  INLINE_PASTE_BYTES, MAX_TEXT_PASTE_BYTES,
} from './terminal-paste.js';

describe('text paste bounds', () => {
  it('keeps only small UTF-8 payloads inline, including exact boundaries', () => {
    expect(classifyTextPaste('')).toBe('inline');
    expect(classifyTextPaste('a'.repeat(INLINE_PASTE_BYTES))).toBe('inline');
    expect(classifyTextPaste('a'.repeat(INLINE_PASTE_BYTES + 1))).toBe('file');
    expect(classifyTextPaste('\u{1f600}'.repeat(INLINE_PASTE_BYTES / 4))).toBe('inline');
    expect(classifyTextPaste('\u{1f600}'.repeat(INLINE_PASTE_BYTES / 4 + 1))).toBe('file');
    expect(classifyTextPaste('a'.repeat(MAX_TEXT_PASTE_BYTES))).toBe('file');
  });

  it('rejects massive payloads without encoding them or allocating another full copy', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(classifyTextPaste('x'.repeat(MAX_TEXT_PASTE_BYTES + 1))).toBe('too-large');
      expect(encode).not.toHaveBeenCalled();
      expect(() => textPasteBody('x'.repeat(MAX_TEXT_PASTE_BYTES + 1))).toThrow('4 MiB limit');
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it('uses the exact UTF-8 blob size, not UTF-16 length, at the file limit', () => {
    const body = textPasteBody('\u{1f600}'.repeat(MAX_TEXT_PASTE_BYTES / 4));
    expect(body.size).toBe(MAX_TEXT_PASTE_BYTES);
    expect(body.type).toBe('text/plain;charset=utf-8');
    expect(() => textPasteBody('\u{1f600}'.repeat(MAX_TEXT_PASTE_BYTES / 4 + 1))).toThrow('UTF-8 limit');
  });
});

describe('file-backed paste references', () => {
  it.each([
    { path: "C:\\owned text\\it's.txt", windows: true, quoted: "C:\\owned text\\it''s.txt" },
    { path: "\\\\host\\owned\\paste.txt", windows: true, quoted: "\\\\host\\owned\\paste.txt" },
    { path: "/owned text/it's.txt", windows: false, quoted: "/owned text/it'\"'\"'s.txt" },
  ])('builds a short provider-neutral reference for $path', ({ path, windows, quoted }) => {
    expect(textPasteReference({ sessionId: 's1', path }, 's1', windows))
      .toBe(`Read the full pasted text from the UTF-8 file '${quoted}'.`);
  });

  it.each([
    null, false, {}, { sessionId: 'other', path: '/owned/paste.txt' },
    { sessionId: 's1' }, { sessionId: 's1', path: false }, { sessionId: 's1', path: '' },
    { sessionId: 's1', path: '/x'.repeat(4097) },
    { sessionId: 's1', path: '/owned/\nexecute.txt' },
    { sessionId: 's1', path: 'relative/path.txt' },
  ])('rejects malformed, stale-session and terminal-control responses: %j', (value) => {
    expect(() => textPasteReference(value, 's1', false)).toThrow('Nothing was pasted');
  });

  it('rejects non-absolute Windows paths', () => {
    expect(() => textPasteReference({ sessionId: 's1', path: 'C:relative.txt' }, 's1', true)).toThrow('invalid');
  });

  it('refuses references whose escaping or UTF-8 size would itself create another large paste', () => {
    expect(() => textPasteReference({ sessionId: 's1', path: `/${"'".repeat(1000)}` }, 's1', false)).toThrow('reference was too long');
    expect(() => textPasteReference({ sessionId: 's1', path: `/${'\u754c'.repeat(1400)}` }, 's1', false)).toThrow('reference was too long');
  });
});
