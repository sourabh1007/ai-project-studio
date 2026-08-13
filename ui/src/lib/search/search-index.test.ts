import { describe, expect, it } from 'vitest';
import {
  groupHitsByKind,
  searchEntries,
  type SearchEntry,
} from './search-index.js';

const entries: SearchEntry[] = [
  { id: 'f1', kind: 'file', title: 'auth.ts', subtitle: 'src/auth', keywords: ['login'] },
  { id: 'c1', kind: 'class', title: 'AuthService' },
  { id: 'm1', kind: 'method', title: 'authenticate', subtitle: 'AuthService' },
  { id: 's1', kind: 'session', title: 'Fix login bug' },
  { id: 'a1', kind: 'ai', title: 'auth summary' },
];

describe('searchEntries', () => {
  it('returns every entry unscored for an empty query', () => {
    const hits = searchEntries(entries, '   ');
    expect(hits).toHaveLength(entries.length);
    expect(hits.every((hit) => hit.score === 0)).toBe(true);
    expect(hits.map((hit) => hit.entry.id)).toEqual([
      'f1',
      'c1',
      'm1',
      's1',
      'a1',
    ]);
  });

  it('returns only fuzzy matches for a query', () => {
    const ids = searchEntries(entries, 'auth').map((hit) => hit.entry.id);
    expect(ids).toContain('f1');
    expect(ids).toContain('c1');
    expect(ids).not.toContain('s1');
  });

  it('matches against subtitle and keywords, not just the title', () => {
    expect(searchEntries(entries, 'login').map((h) => h.entry.id)).toContain(
      'f1',
    );
    expect(searchEntries(entries, 'src').map((h) => h.entry.id)).toContain('f1');
  });

  it('applies kind weight as a tie-break so files outrank ai results', () => {
    const custom: SearchEntry[] = [
      { id: 'ai', kind: 'ai', title: 'xy' },
      { id: 'file', kind: 'file', title: 'xy' },
    ];
    const ids = searchEntries(custom, 'xy').map((hit) => hit.entry.id);
    expect(ids[0]).toBe('file');
  });

  it('breaks exact score+weight ties alphabetically by title', () => {
    const custom: SearchEntry[] = [
      { id: 'b', kind: 'file', title: 'beta' },
      { id: 'a', kind: 'file', title: 'alpha' },
    ];
    const ids = searchEntries(custom, 'a').map((hit) => hit.entry.id);
    expect(ids).toEqual(['a', 'b']);
  });

  it('caps results when a positive limit is given', () => {
    expect(searchEntries(entries, 'auth', 1)).toHaveLength(1);
  });

  it('ignores a non-positive limit', () => {
    const all = searchEntries(entries, 'auth');
    expect(searchEntries(entries, 'auth', 0)).toHaveLength(all.length);
  });

  it('caps unscored empty-query results when limited', () => {
    expect(searchEntries(entries, '', 2)).toHaveLength(2);
  });
});

describe('groupHitsByKind', () => {
  it('groups hits by kind preserving first-seen order and inner order', () => {
    const groups = groupHitsByKind(searchEntries(entries, ''));
    expect(groups.map((g) => g.kind)).toEqual([
      'file',
      'class',
      'method',
      'session',
      'ai',
    ]);
    expect(groups[0].hits.map((h) => h.entry.id)).toEqual(['f1']);
  });

  it('collects multiple hits of the same kind into one bucket', () => {
    const custom: SearchEntry[] = [
      { id: 'f1', kind: 'file', title: 'a' },
      { id: 'f2', kind: 'file', title: 'b' },
    ];
    const groups = groupHitsByKind(searchEntries(custom, ''));
    expect(groups).toHaveLength(1);
    expect(groups[0].hits.map((h) => h.entry.id)).toEqual(['f1', 'f2']);
  });

  it('returns nothing for no hits', () => {
    expect(groupHitsByKind([])).toEqual([]);
  });
});
