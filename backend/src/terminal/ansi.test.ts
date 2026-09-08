import { describe, it, expect } from 'vitest';
import { createAnsiStripper, stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
  it('removes colour (SGR) escape sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });

  describe('streaming transcript ANSI filter', () => {
    const cases: Array<[string, string]> = [
      ['plain\r\n\ttext 😀', 'plain\r\n\ttext 😀'],
      ['\x1b[31mred\x1b[0m', 'red'],
      ['\x1b[?25lhi\x07\x1b[?25h', 'hi'],
      ['\x1b]0;window title\x07visible', 'visible'],
      ['\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\', 'link'],
      ['\x1bPprivate\x1b\\a\x1bXignored\x1b\\b\x1b^ignored\x1b\\c\x1b_ignored\x1b\\d', 'abcd'],
      ['\x9dtitle\x9c\x90private\x9c\x98sos\x9c\x9epm\x9c\x9fapc\x9c\x9b32mgreen\x9b0m', 'green'],
      ['\x1b(Bascii\x1b)0\x1b7saved\x1b8restored', 'asciisavedrestored'],
      ['\x1b# !8text', 'text'],
      ['\x1b[123\r\n\tmtext', '\r\n\ttext'],
      ['\x1b[123\x18text\x1b]title\x1acontinues', 'textcontinues'],
      ['\x1b]title\x1b!still hidden\x1b\x1b\\text', 'text'],
      ['\x1bPtext\x07not an OSC terminator\x1b\\visible', 'visible'],
      ['a\x9cb\x07c', 'abc'],
      ['\x1b[12\x1b[31mred', 'red'],
      ['\x1b(\u0080Btext', 'text'],
      ['text\x1b[123', 'text'],
    ];

    it.each(cases)('strips every split of %j identically', (input, expected) => {
      for (let split = 0; split <= input.length; split++) {
        const filter = createAnsiStripper();
        expect(filter(input.slice(0, split)) + filter(input.slice(split))).toBe(expected);
      }
      const filter = createAnsiStripper();
      expect(input.split('').map(filter).join('')).toBe(expected);
    });

    it('keeps independent session state and discards long unterminated control strings', () => {
      const first = createAnsiStripper();
      const second = createAnsiStripper();
      expect(first('\x1b]')).toBe('');
      for (let i = 0; i < 100; i++) expect(first('x'.repeat(10_000))).toBe('');
      expect(second('plain')).toBe('plain');
      expect(first('\x1b\\restored')).toBe('restored');
    });
  });

  it('removes cursor and screen control codes', () => {
    expect(stripAnsi('\u001b[2J\u001b[Habc')).toBe('abc');
  });

  it('removes bell and private-mode toggles', () => {
    expect(stripAnsi('\u001b[?25lhi\u0007\u001b[?25h')).toBe('hi');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123');
  });
});
