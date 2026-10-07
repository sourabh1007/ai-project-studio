import { describe, it, expect } from 'vitest';
import {
  buildResponseHtmlDocument,
  responseFileName,
  responseFileNameStem,
} from './prompt-export.js';

describe('responseFileNameStem', () => {
  it('slugifies prompt text', () => {
    expect(responseFileNameStem('Fix the Bug!')).toBe('fix-the-bug');
  });

  it('collapses runs of punctuation/whitespace and trims hyphens', () => {
    expect(responseFileNameStem('  Hello,   world -- again  ')).toBe('hello-world-again');
  });

  it('caps length and trims a trailing hyphen left by the cut', () => {
    const stem = responseFileNameStem('a'.repeat(40) + ' ' + 'b'.repeat(40));
    expect(stem.length).toBeLessThanOrEqual(48);
    expect(stem.endsWith('-')).toBe(false);
  });

  it('falls back to "response" when nothing usable remains', () => {
    expect(responseFileNameStem('!!!')).toBe('response');
    expect(responseFileNameStem('')).toBe('response');
  });
});

describe('responseFileName', () => {
  it('appends the requested extension', () => {
    expect(responseFileName('Design review notes', 'md')).toBe('design-review-notes.md');
    expect(responseFileName('Design review notes', 'html')).toBe('design-review-notes.html');
  });
});

describe('buildResponseHtmlDocument', () => {
  it('wraps body html in a full document with an escaped title', () => {
    const doc = buildResponseHtmlDocument('A <b> & "x"', '<p>hi</p>');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('<title>A &lt;b&gt; &amp; &quot;x&quot;</title>');
    expect(doc).toContain('<h1>A &lt;b&gt; &amp; &quot;x&quot;</h1>');
    expect(doc).toContain('<p>hi</p>');
  });

  it('defaults a blank title to "Response"', () => {
    const doc = buildResponseHtmlDocument('   ', '<p>body</p>');
    expect(doc).toContain('<title>Response</title>');
    expect(doc).toContain('<h1>Response</h1>');
  });
});
