import { describe, expect, it } from 'vitest';
import {
  deriveName,
  firstMeaningfulLine,
  frontmatterValue,
  parseDefinition,
  truncate,
} from './frontmatter.js';

describe('parseDefinition', () => {
  it('parses flat frontmatter and returns the trailing body', () => {
    const { frontmatter, body } = parseDefinition(
      ['---', 'name: Code Reviewer', "author: 'Alice'", 'title: "Deep Dive"', '---', 'Body line', 'more'].join(
        '\r\n',
      ),
    );
    expect(frontmatter).toEqual({
      name: 'Code Reviewer',
      author: 'Alice',
      title: 'Deep Dive',
    });
    expect(body).toBe('Body line\nmore');
  });

  it('ignores lines without a colon and lines with an empty key', () => {
    const { frontmatter } = parseDefinition(
      ['---', 'no colon here', ': orphan value', 'ok: yes', '---', ''].join('\n'),
    );
    expect(frontmatter).toEqual({ ok: 'yes' });
  });

  it('treats content without an opening fence as pure body', () => {
    expect(parseDefinition('# Just a heading\ntext')).toEqual({
      frontmatter: {},
      body: '# Just a heading\ntext',
    });
  });

  it('treats an unterminated fence as pure body', () => {
    const content = '---\nname: X\nstill going';
    expect(parseDefinition(content)).toEqual({ frontmatter: {}, body: content });
  });
});

describe('frontmatterValue', () => {
  it('returns a trimmed value when present and non-empty', () => {
    expect(frontmatterValue({ name: '  Foo  ' }, 'name')).toBe('Foo');
  });

  it('returns null for a missing or blank value', () => {
    expect(frontmatterValue({}, 'name')).toBeNull();
    expect(frontmatterValue({ name: '   ' }, 'name')).toBeNull();
  });
});

describe('firstMeaningfulLine', () => {
  it('returns the first non-empty line, stripping a heading marker', () => {
    expect(firstMeaningfulLine('\n\n## Title here\nbody')).toBe('Title here');
  });

  it('returns null when the body has no content', () => {
    expect(firstMeaningfulLine('\n   \n')).toBeNull();
  });
});

describe('deriveName', () => {
  it('strips the extension case-insensitively from the base name', () => {
    expect(deriveName('.github/agents/code-reviewer.md', '.md')).toBe(
      'code-reviewer',
    );
    expect(deriveName('DOCS/GUIDE.MD', '.md')).toBe('GUIDE');
  });

  it('returns the base name unchanged when the extension does not match', () => {
    expect(deriveName('dir/README', '.md')).toBe('README');
  });
});

describe('truncate', () => {
  it('appends an ellipsis only when the value exceeds the limit', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('stripQuotes edge cases via parseDefinition', () => {
  it('leaves single-character and mismatched-quote values intact', () => {
    const { frontmatter } = parseDefinition(
      ['---', 'a: "', "b: \"foo'", '---', ''].join('\n'),
    );
    expect(frontmatter.a).toBe('"');
    expect(frontmatter.b).toBe('"foo\'');
  });
});
