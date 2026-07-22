import { describe, it, expect } from 'vitest';
import { LineAssembler } from './stream-reader.js';

describe('stream-reader / LineAssembler', () => {
  it('emits complete lines and buffers partials across chunks', () => {
    const a = new LineAssembler();
    expect(a.push('hel')).toEqual([]);
    expect(a.push('lo\nwor')).toEqual(['hello']);
    expect(a.push('ld\n')).toEqual(['world']);
  });

  it('handles multiple lines in one chunk', () => {
    const a = new LineAssembler();
    expect(a.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('strips trailing carriage returns (CRLF)', () => {
    const a = new LineAssembler();
    expect(a.push('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('flush returns trailing text without a newline, then clears', () => {
    const a = new LineAssembler();
    a.push('partial');
    expect(a.flush()).toBe('partial');
    expect(a.flush()).toBeUndefined();
  });

  it('flush strips a trailing carriage return', () => {
    const a = new LineAssembler();
    a.push('partial\r');
    expect(a.flush()).toBe('partial');
  });
});
