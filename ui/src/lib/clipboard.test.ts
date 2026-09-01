import { describe, expect, it } from 'vitest';
import {
  classifyCopyCut,
  fieldSelectionText,
  toClipboardText,
  createPasteGuard,
  type ClipboardKeyEvent,
} from './clipboard.js';

function evt(over: Partial<ClipboardKeyEvent>): ClipboardKeyEvent {
  return {
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  };
}

describe('classifyCopyCut', () => {
  it('classifies Ctrl+C and Cmd+C as copy', () => {
    expect(classifyCopyCut(evt({ key: 'c', ctrlKey: true }))).toBe('copy');
    expect(classifyCopyCut(evt({ key: 'C', metaKey: true }))).toBe('copy');
  });

  it('classifies Ctrl+X and Cmd+X as cut', () => {
    expect(classifyCopyCut(evt({ key: 'x', ctrlKey: true }))).toBe('cut');
    expect(classifyCopyCut(evt({ key: 'X', metaKey: true }))).toBe('cut');
  });

  it('ignores the key without a Ctrl/Cmd modifier', () => {
    expect(classifyCopyCut(evt({ key: 'c' }))).toBeNull();
  });

  it('ignores Shift/Alt variants so it never shadows richer chords', () => {
    expect(classifyCopyCut(evt({ key: 'c', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(classifyCopyCut(evt({ key: 'x', metaKey: true, altKey: true }))).toBeNull();
  });

  it('ignores other keys', () => {
    expect(classifyCopyCut(evt({ key: 'v', ctrlKey: true }))).toBeNull();
    expect(classifyCopyCut(evt({ key: 'a', ctrlKey: true }))).toBeNull();
  });
});

describe('fieldSelectionText', () => {
  it('returns the selected substring', () => {
    expect(
      fieldSelectionText({ value: 'hello world', selectionStart: 0, selectionEnd: 5 }),
    ).toBe('hello');
  });

  it('handles a backwards selection', () => {
    expect(
      fieldSelectionText({ value: 'hello world', selectionStart: 11, selectionEnd: 6 }),
    ).toBe('world');
  });

  it('returns empty string for a collapsed or absent selection', () => {
    expect(
      fieldSelectionText({ value: 'hello', selectionStart: 2, selectionEnd: 2 }),
    ).toBe('');
    expect(
      fieldSelectionText({ value: 'hello', selectionStart: null, selectionEnd: null }),
    ).toBe('');
    expect(
      fieldSelectionText({ value: 'hello', selectionStart: 1, selectionEnd: null }),
    ).toBe('');
  });
});

describe('toClipboardText', () => {
  it('removes terminal frame pipes injected at wrapped row boundaries', () => {
    expect(
      toClipboardText(
        '   at Service.OpenAsync(IStatelessServicePartition   |  partition, CancellationToken cancellationToken)   |',
        false,
      ),
    ).toBe(
      '   at Service.OpenAsync(IStatelessServicePartition partition, CancellationToken cancellationToken)',
    );
  });

  it('removes selected terminal side borders without flattening real lines', () => {
    expect(
      toClipboardText(
        '| System.InvalidOperationException: boom   |\n|   at Service.OpenAsync()                |\nplain A|B text',
        false,
      ),
    ).toBe(
      'System.InvalidOperationException: boom\n  at Service.OpenAsync()\nplain A|B text',
    );
  });

  it('preserves real leading pipes when there is no matching terminal frame edge', () => {
    expect(toClipboardText('| grep-ready output\nA|B', false)).toBe(
      '| grep-ready output\nA|B',
    );
  });

  it('cleans phantom separators from serialized wrapped scrollback after repaint', () => {
    const serializedAfterNarrowReflow =
      'System.InvalidOperationException: Example failure      |     \n' +
      '   at Worker.OpenAsync(IStatelessServicePartition   |  partition, CancellationToken cancellationToken)\n' +
      '   at Worker.RunAsync(CancellationToken cancellationToken)      |     ';

    expect(toClipboardText(serializedAfterNarrowReflow, false)).toBe(
      'System.InvalidOperationException: Example failure\n' +
        '   at Worker.OpenAsync(IStatelessServicePartition partition, CancellationToken cancellationToken)\n' +
        '   at Worker.RunAsync(CancellationToken cancellationToken)',
    );
  });

  it('converts LF to CRLF on Windows', () => {
    expect(toClipboardText('a\nb\nc', true)).toBe('a\r\nb\r\nc');
  });

  it('never doubles an existing CR on Windows', () => {
    expect(toClipboardText('a\r\nb', true)).toBe('a\r\nb');
  });

  it('leaves line endings untouched off Windows', () => {
    expect(toClipboardText('a\nb', false)).toBe('a\nb');
  });
});

describe('createPasteGuard', () => {
  it('accepts the first paste and rejects an identical one inside the window', () => {
    const guard = createPasteGuard(50);
    expect(guard.shouldPaste('hi', 1000)).toBe(true);
    expect(guard.shouldPaste('hi', 1010)).toBe(false);
  });

  it('anchors the window to the first paste, not the rejected duplicates', () => {
    const guard = createPasteGuard(50);
    expect(guard.shouldPaste('hi', 1000)).toBe(true);
    expect(guard.shouldPaste('hi', 1040)).toBe(false);
    // 1080 is >50ms after the accepted paste at 1000, so it is a fresh paste.
    expect(guard.shouldPaste('hi', 1080)).toBe(true);
  });

  it('accepts an identical paste once the window has elapsed', () => {
    const guard = createPasteGuard(50);
    expect(guard.shouldPaste('hi', 1000)).toBe(true);
    expect(guard.shouldPaste('hi', 1100)).toBe(true);
  });

  it('accepts different text immediately', () => {
    const guard = createPasteGuard(50);
    expect(guard.shouldPaste('hi', 1000)).toBe(true);
    expect(guard.shouldPaste('bye', 1005)).toBe(true);
  });
});
