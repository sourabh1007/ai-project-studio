import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAnsiSafeUtf8TailBuffer,
  createUtf8TailBuffer,
} from './terminal-local-buffer.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([createUtf8TailBuffer, createAnsiSafeUtf8TailBuffer])(
  'never scans a whole retained window while appending to a saturated buffer',
  (create) => {
    const buffer = create(512 * 1024);
    buffer.append('a'.repeat(512 * 1024));
    const original = String.prototype.charCodeAt;
    let longestInput = 0;
    String.prototype.charCodeAt = function (this: string, index: number) {
      longestInput = Math.max(longestInput, this.length);
      return original.call(this, index);
    };
    try {
      buffer.append('b'.repeat(8192));
    } finally {
      String.prototype.charCodeAt = original;
    }
    expect(longestInput).toBeLessThanOrEqual(8192);
    expect(buffer.text()).toBe('a'.repeat(512 * 1024 - 8192) + 'b'.repeat(8192));
  },
);

it.each([createUtf8TailBuffer, createAnsiSafeUtf8TailBuffer])(
  'rejects invalid budgets and keeps Unicode intact across internal blocks',
  (create) => {
    for (const max of [-1, NaN, Infinity, 1.5]) {
      expect(() => create(max)).toThrow('nonnegative safe integer');
    }
    const buffer = create(8200);
    buffer.append('a'.repeat(4095) + '😀' + 'b'.repeat(4096));
    expect(buffer.text()).toBe('a'.repeat(4095) + '😀' + 'b'.repeat(4096));
    buffer.append('\ud800x\udc00');
    expect(buffer.text().endsWith('\ufffdx\ufffd')).toBe(true);
    expect(Buffer.byteLength(buffer.text())).toBeLessThanOrEqual(8200);
  },
);

describe('createUtf8TailBuffer', () => {
  it('ignores empty chunks', () => {
    const buffer = createUtf8TailBuffer(4);
    buffer.append('');
    expect(buffer.text()).toBe('');
  });

  it('drops everything when the cap is zero', () => {
    const buffer = createUtf8TailBuffer(0);
    buffer.append('hello');
    expect(buffer.text()).toBe('');
  });

  it('keeps the exact ASCII suffix within the byte cap', () => {
    const buffer = createUtf8TailBuffer(4);
    buffer.append('abcdefgh');
    expect(buffer.text()).toBe('efgh');
  });

  it('retains a whole multibyte suffix without splitting a valid surrogate pair', () => {
    const buffer = createUtf8TailBuffer(4);
    buffer.append(`a${'😀'}`);
    expect(buffer.text()).toBe('😀');
  });

  it('re-forms a surrogate pair that arrives across chunk boundaries before trimming', () => {
    const buffer = createUtf8TailBuffer(4);
    buffer.append('a\ud83d');
    expect(buffer.text()).toBe('a');
    buffer.append('\ude00');
    expect(buffer.text()).toBe('😀');
  });

  it('flushes a trailing lone surrogate only when finalized', () => {
    const buffer = createUtf8TailBuffer(3);
    buffer.append('\ud83d');
    expect(buffer.text()).toBe('');
    buffer.finalize();
    expect(buffer.text()).toBe('\ufffd');
  });

  it('treats a pending high surrogate as invalid text when the next chunk does not complete it', () => {
    const buffer = createUtf8TailBuffer(8);
    buffer.append('\ud83d');
    buffer.append('x');
    expect(buffer.text()).toBe('\ufffdx');
  });

  it('finalize is a no-op when no surrogate is pending', () => {
    const buffer = createUtf8TailBuffer(4);
    buffer.append('done');
    buffer.finalize();
    expect(buffer.text()).toBe('done');
  });

  it('handles many chunks and a huge single frame without rescanning total history', () => {
    const buffer = createUtf8TailBuffer(8);
    for (let i = 0; i < 32; i++) {
      buffer.append('ab');
    }
    expect(buffer.text()).toBe('abababab');

    buffer.append('😀'.repeat(1024));
    expect(buffer.text()).toBe('😀😀');
  });

  it('keeps byte-length work linear in appended input instead of rescanning the whole window', () => {
    const original = Buffer.byteLength;
    let scanned = 0;
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
      if (typeof value === 'string') {
        scanned += value.length;
      }
      return original(value, encoding);
    });
    const buffer = createUtf8TailBuffer(1024);
    for (let i = 0; i < 4096; i++) {
      buffer.append('a');
    }
    expect(buffer.text()).toHaveLength(1024);
    expect(scanned).toBeLessThan(4096 * 16);
  });
});

describe('createAnsiSafeUtf8TailBuffer', () => {
  it('exposes the current dropped-control state after a split ST prefix', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('\x1b]0;hidden');
    buffer.append('\x1b');
    expect(buffer.lateJoinState()?.stringEscape).toBe(true);
    buffer.append('\\visible');
    expect(buffer.lateJoinState()).toBeNull();
    expect(buffer.text()).toBe('ible');
  });

  it('keeps following text when a truncated CSI contains embedded C0 whitespace', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(10);
    buffer.append('\x1b[12\n34mOK');
    buffer.append('Z');
    expect(buffer.text()).toBe('OKZ');
    expect(buffer.lateJoinState()).toBeNull();
  });

  it('ignores empty chunks', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('');
    expect(buffer.text()).toBe('');
  });

  it('drops everything when the raw replay cap is zero', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(0);
    buffer.append('\u001b[31mred');
    expect(buffer.text()).toBe('');
    expect(buffer.lateJoinState()).toBeNull();
  });

  it('keeps the exact ASCII suffix when truncation does not cross control sequences', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('abcdefgh');
    expect(buffer.text()).toBe('efgh');
  });

  it('starts replay after a full CSI sequence instead of replaying a garbled tail', () => {
    const input = '\u001b[31mred';
    for (let split = 0; split <= input.length; split++) {
      const buffer = createAnsiSafeUtf8TailBuffer(4);
      buffer.append(input.slice(0, split));
      buffer.append(input.slice(split));
      expect(buffer.text()).toBe('red');
    }
  });

  it('starts replay after a full OSC hyperlink prefix instead of inside it', () => {
    const input = '\u001b]8;;https://example.test\u001b\\link';
    for (let split = 0; split <= input.length; split++) {
      const buffer = createAnsiSafeUtf8TailBuffer(4);
      buffer.append(input.slice(0, split));
      buffer.append(input.slice(split));
      expect(buffer.text()).toBe('link');
    }
  });

  it('drops fully-trimmed leading text and closed control runs without reparsing the whole prefix', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('ab');
    buffer.append('\u001b[31m');
    buffer.append('cd');
    expect(buffer.text()).toBe('cd');
  });

  it('clears late-join carry state when truncation drops only closed control data', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(1);
    buffer.append('\u001b[31m');
    expect(buffer.text()).toBe('');
    expect(buffer.lateJoinState()).toBeNull();
  });

  it('bounds parser state for unterminated control strings', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('\u001b]title-without-end');
    expect(buffer.text()).toBe('');
    expect(buffer.lateJoinState()).not.toBeNull();
    buffer.append('still-hidden');
    expect(buffer.text()).toBe('');
    buffer.append('\u001b\\ok');
    expect(buffer.text()).toBe('ok');
    expect(buffer.lateJoinState()).toBeNull();
  });

  it('remembers an unterminated control string even when the terminator arrives alone', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('\u001b]title-without-end');
    buffer.append('\u001b\\');
    expect(buffer.text()).toBe('');
    buffer.append('ok');
    expect(buffer.text()).toBe('ok');
  });

  it('buffers a trailing high surrogate until it either pairs or finalizes', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('a\ud83d');
    expect(buffer.text()).toBe('a');
    buffer.append('\ude00');
    expect(buffer.text()).toBe('😀');

    const invalid = createAnsiSafeUtf8TailBuffer(4);
    invalid.append('\ud83d');
    expect(invalid.text()).toBe('');
    invalid.finalize();
    expect(invalid.text()).toBe('\ufffd');
  });

  it('drops hidden trailing invalid units when EOF happens inside a truncated control string', () => {
    const buffer = createAnsiSafeUtf8TailBuffer(4);
    buffer.append('\u001b]0;xxxxxxxxxxxx\ud83d');
    expect(buffer.text()).toBe('');
    buffer.finalize();
    expect(buffer.text()).toBe('');
    expect(buffer.lateJoinState()).not.toBeNull();
  });

  it('keeps raw replay byte scanning linear in appended input', () => {
    const original = Buffer.byteLength;
    let scanned = 0;
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
      if (typeof value === 'string') {
        scanned += value.length;
      }
      return original(value, encoding);
    });
    const buffer = createAnsiSafeUtf8TailBuffer(1024);
    for (let i = 0; i < 4096; i++) {
      buffer.append('a');
    }
    expect(buffer.text()).toHaveLength(1024);
    expect(scanned).toBeLessThan(4096 * 16);
  });
});
