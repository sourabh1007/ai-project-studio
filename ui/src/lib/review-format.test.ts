import { describe, expect, it } from 'vitest';
import {
  openFindingCount,
  parseResolutions,
  resolutionOf,
  splitIntoBullets,
  withResolution,
  type FindingResolutionMap,
} from './review-format.js';

describe('splitIntoBullets', () => {
  it('returns an empty list for blank input', () => {
    expect(splitIntoBullets('')).toEqual([]);
    expect(splitIntoBullets('   ')).toEqual([]);
  });

  it('returns a single bullet for one sentence', () => {
    expect(splitIntoBullets('It works well.')).toEqual(['It works well.']);
  });

  it('splits multiple sentences into separate bullets', () => {
    expect(
      splitIntoBullets('The problem is scope. The solution moves settings.'),
    ).toEqual(['The problem is scope.', 'The solution moves settings.']);
  });

  it('splits on semicolons', () => {
    expect(splitIntoBullets('First clause; second clause.')).toEqual([
      'First clause',
      'second clause.',
    ]);
  });

  it('does not split on fallback arrows or lowercase continuations', () => {
    const text = 'It uses RID → account → base key fallback for lookups.';
    expect(splitIntoBullets(text)).toEqual([text]);
  });

  it('keeps a trailing sentence without terminal punctuation', () => {
    expect(splitIntoBullets('One thing. Another thing')).toEqual([
      'One thing.',
      'Another thing',
    ]);
  });

  it('returns the trailing semicolon token as its own bullet', () => {
    expect(splitIntoBullets('first; ;')).toEqual(['first', ';']);
  });
});

describe('resolutionOf / openFindingCount', () => {
  it('reads a decision or null', () => {
    const map: FindingResolutionMap = { a: 'resolved' };
    expect(resolutionOf(map, 'a')).toBe('resolved');
    expect(resolutionOf(map, 'b')).toBeNull();
  });

  it('counts findings with no decision', () => {
    const map: FindingResolutionMap = { a: 'resolved', b: 'ignored' };
    expect(openFindingCount(map, ['a', 'b', 'c', 'd'])).toBe(2);
    expect(openFindingCount({}, [])).toBe(0);
  });
});

describe('withResolution', () => {
  it('sets a resolution without mutating the input', () => {
    const map: FindingResolutionMap = {};
    const next = withResolution(map, 'a', 'ignored');
    expect(next.a).toBe('ignored');
    expect(map.a).toBeUndefined();
  });

  it('clears a resolution when passed null', () => {
    const map: FindingResolutionMap = { a: 'resolved' };
    expect(withResolution(map, 'a', null).a).toBeUndefined();
  });
});

describe('parseResolutions', () => {
  it('returns empty for non-objects', () => {
    expect(parseResolutions(null)).toEqual({});
    expect(parseResolutions('x')).toEqual({});
  });

  it('keeps only valid resolution values', () => {
    expect(
      parseResolutions({ a: 'resolved', b: 'ignored', c: 'bogus', d: 3 }),
    ).toEqual({ a: 'resolved', b: 'ignored' });
  });
});
