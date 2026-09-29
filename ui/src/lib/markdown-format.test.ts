import { describe, expect, it } from 'vitest';
import { applyMarkdownFormat } from './markdown-format.js';

describe('applyMarkdownFormat', () => {
  it('wraps a selection with inline markers and keeps it selected', () => {
    const result = applyMarkdownFormat('the quick fox', 4, 9, 'bold');
    expect(result.value).toBe('the **quick** fox');
    expect(result.value.slice(result.selectionStart, result.selectionEnd)).toBe(
      'quick',
    );
  });

  it('inserts a placeholder for each empty inline format', () => {
    expect(applyMarkdownFormat('', 0, 0, 'bold').value).toBe('**bold text**');
    expect(applyMarkdownFormat('', 0, 0, 'italic').value).toBe('*italic text*');
    expect(applyMarkdownFormat('', 0, 0, 'strike').value).toBe(
      '~~strikethrough~~',
    );
    const code = applyMarkdownFormat('', 0, 0, 'code');
    expect(code.value).toBe('`code`');
    expect(code.value.slice(code.selectionStart, code.selectionEnd)).toBe('code');
  });

  it('builds a link skeleton and pre-selects the URL', () => {
    const withText = applyMarkdownFormat('see docs', 4, 8, 'link');
    expect(withText.value).toBe('see [docs](https://)');
    expect(
      withText.value.slice(withText.selectionStart, withText.selectionEnd),
    ).toBe('https://');

    const empty = applyMarkdownFormat('', 0, 0, 'link');
    expect(empty.value).toBe('[text](https://)');
    expect(empty.value.slice(empty.selectionStart, empty.selectionEnd)).toBe(
      'https://',
    );
  });

  it('prefixes whole lines for bullets and quotes, expanding the selection', () => {
    const bullets = applyMarkdownFormat('one\ntwo\nthree', 5, 6, 'bullet');
    expect(bullets.value).toBe('one\n- two\nthree');

    const multi = applyMarkdownFormat('one\ntwo', 0, 7, 'quote');
    expect(multi.value).toBe('> one\n> two');
    expect(multi.value.slice(multi.selectionStart, multi.selectionEnd)).toBe(
      '> one\n> two',
    );
  });

  it('expands to whole lines when the caret sits mid-line at the buffer end', () => {
    const result = applyMarkdownFormat('alpha', 2, 2, 'bullet');
    expect(result.value).toBe('- alpha');
  });

  it('fences a selection into a code block', () => {
    const mid = applyMarkdownFormat('a=1', 0, 3, 'codeblock');
    expect(mid.value).toBe('```\na=1\n```');
    expect(mid.value.slice(mid.selectionStart, mid.selectionEnd)).toBe('a=1');
  });

  it('adds a trailing separator when text follows without a newline', () => {
    const result = applyMarkdownFormat('abcd', 0, 2, 'codeblock');
    expect(result.value).toBe('```\nab\n```\ncd');
  });

  it('adds a leading separator when the caret follows non-newline text', () => {
    const result = applyMarkdownFormat('ab', 2, 2, 'codeblock');
    expect(result.value).toBe('ab\n```\ncode\n```');
  });

  it('omits separators when newlines already surround the caret', () => {
    const result = applyMarkdownFormat('a\n\nb', 2, 2, 'codeblock');
    expect(result.value).toBe('a\n```\ncode\n```\nb');
  });

  it('clamps out-of-range and non-finite selections', () => {
    const past = applyMarkdownFormat('abc', 10, 20, 'bold');
    expect(past.value).toBe('abc**bold text**');

    const reversed = applyMarkdownFormat('abcd', 3, 1, 'code');
    // end is clamped to be no less than start.
    expect(reversed.value).toBe('abc`code`d');

    const nan = applyMarkdownFormat('abc', Number.NaN, Number.NaN, 'italic');
    expect(nan.value).toBe('*italic text*abc');

    const negative = applyMarkdownFormat('abc', -5, 2, 'bold');
    expect(negative.value).toBe('**ab**c');
  });
});
