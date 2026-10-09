import { describe, it, expect } from 'vitest';
import { autocorrect, autoformatTitle, suggestTitles } from './planner-text.js';

describe('autocorrect', () => {
  it('fixes common typos while leaving unknown words alone', () => {
    expect(autocorrect('fix teh bug')).toBe('fix the bug');
    expect(autocorrect('deploy widget')).toBe('deploy widget');
  });

  it('uppercases known acronyms', () => {
    expect(autocorrect('review pr')).toBe('review PR');
    expect(autocorrect('ui and api')).toBe('UI and API');
  });

  it('preserves the original casing pattern', () => {
    expect(autocorrect('Teh thing')).toBe('The thing');
    expect(autocorrect('TEH thing')).toBe('THE thing');
  });

  it('keeps punctuation attached to a corrected word', () => {
    expect(autocorrect('(pr),')).toBe('(PR),');
  });

  it('ignores words without letters', () => {
    expect(autocorrect('123 456')).toBe('123 456');
  });

  it('preserves a trailing space so mid-typing keeps working', () => {
    expect(autocorrect('fix teh ')).toBe('fix the ');
    expect(autocorrect('')).toBe('');
  });
});

describe('autoformatTitle', () => {
  it('trims, collapses whitespace and capitalizes', () => {
    expect(autoformatTitle('  fix   the   bug ')).toBe('Fix the bug');
  });

  it('strips a trailing period', () => {
    expect(autoformatTitle('ship it.')).toBe('Ship it');
    expect(autoformatTitle('ship it...')).toBe('Ship it');
  });

  it('returns empty for blank input', () => {
    expect(autoformatTitle('   ')).toBe('');
    expect(autoformatTitle('')).toBe('');
  });
});

describe('suggestTitles', () => {
  const history = ['Fix the login bug', 'Fix the logout bug', 'Review PR #9', 'Fix the login bug'];

  it('returns no suggestions for an empty query', () => {
    expect(suggestTitles('   ', history)).toEqual([]);
  });

  it('matches by prefix, case-insensitively and de-duplicated', () => {
    expect(suggestTitles('fix the log', history)).toEqual([
      'Fix the login bug',
      'Fix the logout bug',
    ]);
  });

  it('skips an entry identical to the query and blank entries', () => {
    expect(suggestTitles('review pr #9', ['Review PR #9', '  '])).toEqual([]);
  });

  it('respects the limit', () => {
    expect(suggestTitles('t', ['ta', 'tb', 'tc'], 2)).toEqual(['ta', 'tb']);
  });
});
