import { describe, expect, it } from 'vitest';
import {
  MAX_TEAM_MEMBERS,
  TEAM_ROSTER_STORAGE_KEY,
  addTeamMember,
  isStringArray,
  isTeamMember,
  loadTeamRoster,
  normalizeTeamRoster,
  removeTeamMember,
  removeTeamMemberByIdentity,
  saveTeamRoster,
} from './team-roster.js';
import type { KeyValueStore } from './persisted-state.js';

/** An in-memory store; `throwing` makes every access fail like a locked-down browser. */
function fakeStore(seed: Record<string, string> = {}, throwing = false): KeyValueStore {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => {
      if (throwing) throw new Error('blocked');
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (throwing) throw new Error('blocked');
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('isStringArray', () => {
  it('accepts arrays of strings and rejects anything else', () => {
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('a')).toBe(false);
    expect(isStringArray(null)).toBe(false);
  });
});

describe('normalizeTeamRoster', () => {
  it('trims, drops blanks, de-dupes case-insensitively, and sorts', () => {
    expect(
      normalizeTeamRoster(['  Bob ', 'ada', 'ADA', '', '   ', 'Cara']),
    ).toEqual(['ada', 'Bob', 'Cara']);
  });

  it('returns an empty roster for non-array input', () => {
    expect(normalizeTeamRoster('nope')).toEqual([]);
    expect(normalizeTeamRoster(undefined)).toEqual([]);
    expect(normalizeTeamRoster([1, 2])).toEqual([]);
  });

  it('caps the roster length', () => {
    const many = Array.from({ length: MAX_TEAM_MEMBERS + 25 }, (_, i) =>
      `member-${String(i).padStart(4, '0')}`,
    );
    expect(normalizeTeamRoster(many)).toHaveLength(MAX_TEAM_MEMBERS);
  });
});

describe('addTeamMember', () => {
  it('adds a new teammate and keeps the roster sorted', () => {
    expect(addTeamMember(['Bob'], 'ada')).toEqual(['ada', 'Bob']);
  });

  it('is a no-op for blanks or existing members (any case)', () => {
    expect(addTeamMember(['Ada'], '  ')).toEqual(['Ada']);
    expect(addTeamMember(['Ada'], 'ADA')).toEqual(['Ada']);
  });
});

describe('removeTeamMember', () => {
  it('removes by case-insensitive name', () => {
    expect(removeTeamMember(['Ada', 'Bob'], 'ada')).toEqual(['Bob']);
    expect(removeTeamMember(['Ada', 'Bob'], ' BOB ')).toEqual(['Ada']);
  });

  it('leaves the roster unchanged when the name is absent', () => {
    expect(removeTeamMember(['Ada'], 'Zed')).toEqual(['Ada']);
  });
});

describe('removeTeamMemberByIdentity', () => {
  it('removes an entry matching the display name or the git username', () => {
    expect(
      removeTeamMemberByIdentity(['octocat', 'Bob'], {
        author: 'Mona',
        login: 'octocat',
      }),
    ).toEqual(['Bob']);
    expect(
      removeTeamMemberByIdentity(['Mona', 'Bob'], {
        author: 'Mona',
        login: 'octocat',
      }),
    ).toEqual(['Bob']);
  });

  it('is a safe no-op when neither identity is present or matches', () => {
    expect(
      removeTeamMemberByIdentity(['Ada'], { author: null, login: null }),
    ).toEqual(['Ada']);
    expect(
      removeTeamMemberByIdentity(['Ada'], { author: 'Zed', login: 'zed99' }),
    ).toEqual(['Ada']);
  });
});

describe('isTeamMember', () => {
  it('matches authors case-insensitively', () => {
    expect(isTeamMember(['Ada Lovelace'], 'ada lovelace')).toBe(true);
    expect(isTeamMember(['Ada'], 'Bob')).toBe(false);
  });

  it('matches the git username (login) when the display name differs', () => {
    expect(isTeamMember(['octocat'], 'Mona', 'octocat')).toBe(true);
    expect(isTeamMember(['octocat'], 'Mona', 'OCTOCAT')).toBe(true);
    expect(isTeamMember(['octocat'], 'Mona', 'hubot')).toBe(false);
  });

  it('returns false for empty or missing authors', () => {
    expect(isTeamMember(['Ada'], null)).toBe(false);
    expect(isTeamMember(['Ada'], undefined)).toBe(false);
    expect(isTeamMember(['Ada'], '   ')).toBe(false);
    expect(isTeamMember(['Ada'], null, null)).toBe(false);
  });
});

describe('loadTeamRoster / saveTeamRoster', () => {
  it('round-trips a normalized roster through the store', () => {
    const store = fakeStore();
    expect(saveTeamRoster(store, ['  Bob ', 'ada', 'ADA'])).toBe(true);
    expect(store.getItem(TEAM_ROSTER_STORAGE_KEY)).toBe(
      JSON.stringify(['ada', 'Bob']),
    );
    expect(loadTeamRoster(store)).toEqual(['ada', 'Bob']);
  });

  it('falls back to an empty roster when nothing is stored', () => {
    expect(loadTeamRoster(fakeStore())).toEqual([]);
  });

  it('ignores corrupt persisted values', () => {
    expect(loadTeamRoster(fakeStore({ [TEAM_ROSTER_STORAGE_KEY]: '{bad' }))).toEqual(
      [],
    );
    expect(
      loadTeamRoster(fakeStore({ [TEAM_ROSTER_STORAGE_KEY]: '"a string"' })),
    ).toEqual([]);
  });

  it('reports a failed write without throwing', () => {
    expect(saveTeamRoster(fakeStore({}, true), ['Ada'])).toBe(false);
  });
});
