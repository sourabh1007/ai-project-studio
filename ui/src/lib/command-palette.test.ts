import { describe, expect, it } from 'vitest';

import {
  type Command,
  filterCommands,
  fuzzyScore,
} from './command-palette.js';

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('pr review', 'xyz')).toBeNull();
    expect(fuzzyScore('abc', 'abcd')).toBeNull();
  });

  it('scores a full contiguous match', () => {
    expect(fuzzyScore('pr', 'pr')).not.toBeNull();
  });

  it('rewards word-boundary starts over mid-word matches', () => {
    const boundary = fuzzyScore('pr review', 'pr');
    const midWord = fuzzyScore('spare', 'pr');
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(boundary as number).toBeGreaterThan(midWord as number);
  });

  it('rewards a boundary match after a space', () => {
    // The "r" of "review" starts right after a space, hitting the boundary bonus.
    expect(fuzzyScore('pr review', 'r')).toBeGreaterThan(0);
  });

  it('resets the streak when characters do not match', () => {
    // Non-contiguous subsequence still matches but scores lower than contiguous.
    const gapped = fuzzyScore('a_b', 'ab');
    const contiguous = fuzzyScore('ab', 'ab');
    expect(gapped).not.toBeNull();
    expect(contiguous as number).toBeGreaterThan(gapped as number);
  });
});

describe('filterCommands', () => {
  const commands: Command[] = [
    { id: 'workspace', title: 'Open Explorer', keywords: ['files'] },
    { id: 'pr', title: 'Review PR' },
    { id: 'theme', title: 'Toggle Theme' },
  ];

  it('returns a copy of all commands for an empty query', () => {
    const result = filterCommands(commands, '   ');
    expect(result).toEqual(commands);
    expect(result).not.toBe(commands);
  });

  it('matches on title', () => {
    expect(filterCommands(commands, 'theme').map((c) => c.id)).toEqual(['theme']);
  });

  it('matches on keywords not present in the title', () => {
    expect(filterCommands(commands, 'files').map((c) => c.id)).toEqual([
      'workspace',
    ]);
  });

  it('excludes non-matching commands', () => {
    expect(filterCommands(commands, 'zzz')).toEqual([]);
  });

  it('sorts by score then alphabetically by title on ties', () => {
    // "Cat" and "Bat" both match 'a' identically (same score); the alphabetical
    // tie-break puts "Bat" first even though it is listed second.
    const tie: Command[] = [
      { id: 'cat', title: 'Cat' },
      { id: 'bat', title: 'Bat' },
    ];
    expect(filterCommands(tie, 'a').map((c) => c.id)).toEqual(['bat', 'cat']);
  });
});
