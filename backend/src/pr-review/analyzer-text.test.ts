import { describe, expect, it } from 'vitest';
import { blankCommentsAndStrings, blankMatches } from './analyzer-text.js';

/** Asserts length is preserved and none of `hidden` survives in the output. */
function expectBlanked(
  src: string,
  out: string,
  { keep = [], hidden = [] }: { keep?: string[]; hidden?: string[] },
): void {
  expect(out.length).toBe(src.length);
  for (const token of keep) {
    expect(out).toContain(token);
  }
  for (const token of hidden) {
    expect(out).not.toContain(token);
  }
}

describe('blankCommentsAndStrings', () => {
  it('keeps ordinary code untouched and preserves length', () => {
    const src = 'class Foo { int x; }';
    const out = blankCommentsAndStrings(src);
    expect(out).toBe(src);
  });

  it('blanks a line comment but preserves the newline', () => {
    const out = blankCommentsAndStrings('a // Store b\nc');
    expect(out).toBe('a           \nc');
  });

  it('blanks a terminated block comment, spaces only', () => {
    const out = blankCommentsAndStrings('a /* Store */ b');
    expect(out).toBe('a             b');
  });

  it('blanks an unterminated block comment to end of input', () => {
    const out = blankCommentsAndStrings('a /* Store');
    expect(out).toBe('a         ');
  });

  it('preserves newlines inside a block comment', () => {
    const out = blankCommentsAndStrings('/* a\nb */x');
    expect(out).toBe('    \n    x');
  });

  it('blanks a double-quoted string with escapes', () => {
    const src = 'x = "Store \\" y" ;';
    const out = blankCommentsAndStrings(src);
    expectBlanked(src, out, { keep: ['x = ', ';'], hidden: ['Store'] });
  });

  it('blanks a char literal', () => {
    const src = "c = 'Q';";
    const out = blankCommentsAndStrings(src);
    expectBlanked(src, out, { keep: ['c = ', ';'], hidden: ['Q'] });
  });

  it('stops a non-verbatim string at a newline (unterminated)', () => {
    const out = blankCommentsAndStrings('"Store\nReal');
    expect(out).toBe('      \nReal');
  });

  it('blanks a string that runs to end of input', () => {
    const src = 'x = "Store';
    const out = blankCommentsAndStrings(src);
    expectBlanked(src, out, { keep: ['x = '], hidden: ['Store'] });
  });

  it('leaves @ literal by default (no csharp option)', () => {
    const src = '@"Store"';
    const out = blankCommentsAndStrings(src);
    // Without the csharp option, @ is ordinary and the plain string blanks.
    expect(out.startsWith('@')).toBe(true);
    expectBlanked(src, out, { hidden: ['Store'] });
  });

  it('blanks a C# verbatim string with doubled-quote escapes', () => {
    const src = 'x = @"C:\\Store ""q"" end";';
    const out = blankCommentsAndStrings(src, { csharp: true });
    expectBlanked(src, out, { keep: ['x = ', ';'], hidden: ['Store', 'end'] });
  });

  it('blanks a C# interpolated string including holes', () => {
    const src = 'x = $"a{Store}b";';
    const out = blankCommentsAndStrings(src, { csharp: true });
    expectBlanked(src, out, { keep: ['x = ', ';'], hidden: ['Store'] });
  });

  it('blanks a combined verbatim-interpolated string', () => {
    const src = 'x = $@"Store ""q""";';
    const out = blankCommentsAndStrings(src, { csharp: true });
    expectBlanked(src, out, { keep: ['x = ', ';'], hidden: ['Store'] });
  });

  it('blanks an unterminated verbatim string to end of input', () => {
    const out = blankCommentsAndStrings('@"Store', { csharp: true });
    expect(out).toBe('       ');
  });

  it('keeps a verbatim identifier (@ not followed by a quote)', () => {
    const out = blankCommentsAndStrings('@class x', { csharp: true });
    expect(out).toBe('@class x');
  });

  it('keeps a lone $ that is not a string prefix', () => {
    const out = blankCommentsAndStrings('a $ b', { csharp: true });
    expect(out).toBe('a $ b');
  });
});

describe('blankMatches', () => {
  it('replaces matches with equal-length spaces', () => {
    const out = blankMatches('using A.B;\ncode', /using[^\n]*/g);
    expect(out).toBe('          \ncode');
  });

  it('returns the input unchanged when nothing matches', () => {
    expect(blankMatches('code only', /using[^\n]*/g)).toBe('code only');
  });
});
