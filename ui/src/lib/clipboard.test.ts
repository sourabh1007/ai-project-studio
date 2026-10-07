import { describe, expect, it, vi } from 'vitest';
import {
  classifyCopyCut,
  fieldSelectionText,
  toClipboardText,
  decodeOsc52,
  createPasteGuard,
  attachmentFailureMessage,
  writeClipboardText,
  type ClipboardResult,
  type ClipboardKeyEvent,
} from './clipboard.js';

it('routes attachment quota failures to the mounted manual manager without implying automatic cleanup', () => {
  const message = attachmentFailureMessage('quota');
  expect(message).toContain('No attachment was pasted');
  expect(message).toContain('Settings → Diagnostics → Retained clipboard images');
  expect(message).toContain('Manual deletion may break active, past, or resumed prompts');
  expect(message).toContain('Automatic cleanup is not available');
});

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

  it('strips box-drawing right borders regardless of padding or weight', () => {
    expect(toClipboardText('push the changes          │', false)).toBe(
      'push the changes',
    );
    // Single space before a decorative bar — the old 2-space rule missed this.
    expect(toClipboardText('ush the changes │', false)).toBe('ush the changes');
    expect(toClipboardText('heavy border ┃', false)).toBe('heavy border');
    expect(toClipboardText('double border ║', false)).toBe('double border');
    expect(toClipboardText('eighth-block edge ▕', false)).toBe('eighth-block edge');
    expect(toClipboardText('fullwidth bar ｜', false)).toBe('fullwidth bar');
  });

  it('strips a leading thread-rail gutter bar even without a trailing edge', () => {
    expect(toClipboardText('   │ not committed or pushed yet.', false)).toBe(
      'not committed or pushed yet.',
    );
    expect(toClipboardText('│ push the changes', false)).toBe('push the changes');
  });

  it('removes both borders of a box-drawn row', () => {
    expect(toClipboardText('│ MCP server requires auth            │', false)).toBe(
      'MCP server requires auth',
    );
  });

  it('keeps ASCII markdown tables intact', () => {
    expect(toClipboardText('| Name | Value |\n| a | b |', false)).toBe(
      '| Name | Value |\n| a | b |',
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

  it('strips decorative Private Use Area glyphs that paste as unknown characters', () => {
    expect(toClipboardText('\uE0B0 status \uF00C done', false)).toBe(' status  done');
    expect(toClipboardText('icon \uDB80\uDC00 tail', false)).toBe('icon  tail');
  });

  it('removes zero-width marks, byte-order marks and replacement characters', () => {
    expect(toClipboardText('a\u200Bb\uFEFFc\uFFFDd\u200D', false)).toBe('abcd');
  });

  it('normalizes non-breaking spaces to ordinary spaces', () => {
    expect(toClipboardText('a\u00A0b\u202Fc\u2007d', false)).toBe('a b c d');
  });

  it('preserves emoji and box-drawing while stripping artifacts', () => {
    expect(toClipboardText('😀 ├─ ok\uFFFD', false)).toBe('😀 ├─ ok');
  });
});

describe('decodeOsc52', () => {
  const encode = (text: string): string =>
    btoa(String.fromCharCode(...new TextEncoder().encode(text)));

  it('decodes a base64 clipboard-write payload into UTF-8 text', () => {
    expect(decodeOsc52(`c;${encode('hello world')}`)).toBe('hello world');
    expect(decodeOsc52(`c;${encode('café → ≥ 語')}`)).toBe('café → ≥ 語');
  });

  it('tolerates whitespace wrapping in the base64 data', () => {
    const wrapped = `${encode('wrapped payload')}`.replace(/(.{4})/g, '$1\n');
    expect(decodeOsc52(`c;${wrapped}`)).toBe('wrapped payload');
  });

  it('returns null for read queries, empty/clear payloads and missing separators', () => {
    expect(decodeOsc52('c;?')).toBeNull();
    expect(decodeOsc52('c;')).toBeNull();
    expect(decodeOsc52('no-separator')).toBeNull();
  });

  it('returns null for undecodable base64 rather than writing garbage', () => {
    expect(decodeOsc52('c;@@@not-base64@@@')).toBeNull();
  });
});

describe('createPasteGuard', () => {
  it('owns each event once and accepts separate identical user actions immediately', () => {
    const guard = createPasteGuard();
    const first = { text: 'same', time: 0 };
    expect(guard.shouldPaste(first)).toBe(true);
    expect(guard.shouldPaste(first)).toBe(false);
    expect(guard.shouldPaste({ text: 'same', time: 0 })).toBe(true);
  });

  it('collapses separate event objects only inside a short matching signature window', () => {
    const guard = createPasteGuard(50);

    expect(guard.shouldPaste({ id: 1 }, 'text:same', 100)).toBe(true);
    expect(guard.shouldPaste({ id: 2 }, 'text:same', 120)).toBe(false);
    expect(guard.shouldPaste({ id: 3 }, 'text:other', 130)).toBe(true);
    expect(guard.shouldPaste({ id: 4 }, 'text:other', 181)).toBe(true);
    expect(guard.shouldPaste({ id: 5 }, 'text:other', Number.NaN)).toBe(true);
    expect(guard.shouldPaste({ id: 6 }, 'text:other')).toBe(true);
  });
});

describe('acknowledged clipboard writes', () => {
  const ok: ClipboardResult = { ok: true };
  const unavailable: ClipboardResult = { ok: false, error: 'unavailable', writeState: 'not-written' };
  const legacy = vi.fn(() => ok);
  const canFallback = () => true;
  it('awaits native completion, with no browser or legacy write', async () => {
    let finish!: (result: ClipboardResult) => void;
    const browser = vi.fn();
    const pending = writeClipboardText('😀\r\nx', {
      native: () => new Promise((resolve) => { finish = resolve; }),
      browser, legacy, canFallback,
    });
    expect(browser).not.toHaveBeenCalled();
    finish(ok);
    expect(await pending).toEqual(ok);
    expect(browser).not.toHaveBeenCalled();
  });
  it('rejects empty copy without interpreting it as clear', async () => {
    const native = vi.fn();
    expect(await writeClipboardText('', { native, legacy, canFallback }))
      .toEqual({ ok: false, error: 'empty-text', writeState: 'not-written' });
    expect(native).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'written', 'not-written'] as const)('does not retry a %s policy/native failure', async (writeState) => {
    const browser = vi.fn();
    const result: ClipboardResult = { ok: false, error: 'too-large', writeState };
    expect(await writeClipboardText('x', {
      native: async () => result, browser, legacy, canFallback,
    })).toEqual(result);
    expect(browser).not.toHaveBeenCalled();
  });
  it('does not retry rejected IPC or malformed/old void acknowledgements', async () => {
    for (const native of [
      async () => { throw new Error('lost acknowledgement'); },
      async () => undefined as unknown as ClipboardResult,
      async () => ({ ok: 'yes' }) as unknown as ClipboardResult,
    ]) {
      const browser = vi.fn();
      expect(await writeClipboardText('x', { native, browser, legacy, canFallback }))
        .toMatchObject({ ok: false, writeState: 'unknown' });
      expect(browser).not.toHaveBeenCalled();
    }
  });
  it('falls back only on definite unavailability and checks target ownership', async () => {
    const browser = vi.fn(async () => ok);
    expect(await writeClipboardText('x', {
      native: async () => unavailable, browser, legacy, canFallback,
    })).toEqual(ok);
    expect(browser).toHaveBeenCalledTimes(1);
    expect(await writeClipboardText('x', {
      native: async () => unavailable, browser, legacy, canFallback: () => false,
    })).toMatchObject({ error: 'target-changed' });
    expect(browser).toHaveBeenCalledTimes(1);
  });
  it('falls back to browser when the native bridge rejects the frame as untrusted', async () => {
    const untrusted: ClipboardResult = { ok: false, error: 'untrusted', writeState: 'not-written' };
    const browser = vi.fn(async () => ok);
    expect(await writeClipboardText('x', {
      native: async () => untrusted, browser, legacy, canFallback,
    })).toEqual(ok);
    expect(browser).toHaveBeenCalledTimes(1);
  });
  it('supports browser-only, legacy and exhausted fallback outcomes', async () => {
    expect(await writeClipboardText('x', {
      browser: async () => ok, legacy, canFallback,
    })).toEqual(ok);
    expect(await writeClipboardText('x', { legacy, canFallback })).toEqual(ok);
    expect(await writeClipboardText('x', {
      browser: async () => unavailable, legacy: () => unavailable, canFallback,
    })).toEqual(unavailable);
  });
  it('normalizes Windows newline expansion without damaging Unicode at old limits', () => {
    for (const length of [32768, 32769, 65536, 1024 * 1024]) {
      const text = '😀\n' + 'x'.repeat(length - 3);
      const normalized = toClipboardText(text, true);
      expect(normalized.length).toBe(length + 1);
      expect(normalized).toBe('😀\r\n' + 'x'.repeat(length - 3));
    }
  });
});
