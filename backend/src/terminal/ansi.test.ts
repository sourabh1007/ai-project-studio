import { describe, it, expect } from 'vitest';
import { stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
  it('removes colour (SGR) escape sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
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
