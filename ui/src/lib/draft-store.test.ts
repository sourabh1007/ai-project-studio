import { describe, it, expect } from 'vitest';
import {
  isDraft,
  isDraftOrNull,
  makeDraft,
  isDirty,
  resolveDraft,
} from './draft-store';

describe('isDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(isDraft({ value: 'hi', savedAt: '2024-01-01T00:00:00.000Z' })).toBe(
      true,
    );
  });

  it('rejects non-objects and malformed shapes', () => {
    expect(isDraft(null)).toBe(false);
    expect(isDraft('str')).toBe(false);
    expect(isDraft({ value: 'hi' })).toBe(false);
    expect(isDraft({ value: 1, savedAt: 'x' })).toBe(false);
    expect(isDraft({ value: 'hi', savedAt: 2 })).toBe(false);
  });
});

describe('isDraftOrNull', () => {
  it('accepts null and valid drafts, rejects garbage', () => {
    expect(isDraftOrNull(null)).toBe(true);
    expect(isDraftOrNull({ value: 'a', savedAt: 'b' })).toBe(true);
    expect(isDraftOrNull(42)).toBe(false);
  });
});

describe('makeDraft', () => {
  it('stamps the value with the given time', () => {
    expect(makeDraft('text', '2024-06-01T00:00:00.000Z')).toEqual({
      value: 'text',
      savedAt: '2024-06-01T00:00:00.000Z',
    });
  });
});

describe('isDirty', () => {
  it('is true only when the value differs from the base', () => {
    expect(isDirty('a', 'a')).toBe(false);
    expect(isDirty('a', 'b')).toBe(true);
  });
});

describe('resolveDraft', () => {
  it('restores a draft that differs from the base', () => {
    const draft = { value: 'edited', savedAt: 't' };
    expect(resolveDraft(draft, 'saved')).toEqual({
      value: 'edited',
      restored: true,
    });
  });

  it('uses the base when there is no draft', () => {
    expect(resolveDraft(null, 'saved')).toEqual({
      value: 'saved',
      restored: false,
    });
  });

  it('uses the base when the draft matches it (stale draft)', () => {
    const draft = { value: 'saved', savedAt: 't' };
    expect(resolveDraft(draft, 'saved')).toEqual({
      value: 'saved',
      restored: false,
    });
  });
});
