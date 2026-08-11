import { describe, expect, it } from 'vitest';
import {
  createSessionNameStore,
  defaultSessionLabel,
  sessionDisplayName,
  sessionWorkTitle,
  SESSION_NAMES_KEY,
  type SessionNameStorage,
} from './session-names.js';

function memoryStorage(initial: Record<string, string> = {}): SessionNameStorage & {
  raw(): Record<string, string>;
} {
  const data: Record<string, string> = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    raw: () => data,
  };
}

describe('createSessionNameStore', () => {
  it('returns an empty map when nothing is stored', () => {
    const store = createSessionNameStore(memoryStorage());
    expect(store.all()).toEqual({});
  });

  it('reads a previously stored map', () => {
    const storage = memoryStorage({
      [SESSION_NAMES_KEY]: JSON.stringify({ a: 'Alpha' }),
    });
    const store = createSessionNameStore(storage);
    expect(store.all()).toEqual({ a: 'Alpha' });
  });

  it('ignores non-string values in the stored map', () => {
    const storage = memoryStorage({
      [SESSION_NAMES_KEY]: JSON.stringify({ a: 'Alpha', b: 5 }),
    });
    const store = createSessionNameStore(storage);
    expect(store.all()).toEqual({ a: 'Alpha' });
  });

  it('returns an empty map for invalid JSON', () => {
    const storage = memoryStorage({ [SESSION_NAMES_KEY]: 'not-json' });
    const store = createSessionNameStore(storage);
    expect(store.all()).toEqual({});
  });

  it('returns an empty map when the stored value is not an object', () => {
    const storage = memoryStorage({ [SESSION_NAMES_KEY]: '5' });
    expect(createSessionNameStore(storage).all()).toEqual({});
  });

  it('returns an empty map when the stored value is null', () => {
    const storage = memoryStorage({ [SESSION_NAMES_KEY]: 'null' });
    expect(createSessionNameStore(storage).all()).toEqual({});
  });

  it('returns an empty map when the stored value is an array', () => {
    const storage = memoryStorage({ [SESSION_NAMES_KEY]: '[]' });
    expect(createSessionNameStore(storage).all()).toEqual({});
  });

  it('sets a trimmed custom name', () => {
    const storage = memoryStorage();
    const store = createSessionNameStore(storage);
    store.set('a', '  My Session  ');
    expect(store.all()).toEqual({ a: 'My Session' });
  });

  it('clears a name when set to blank', () => {
    const storage = memoryStorage({
      [SESSION_NAMES_KEY]: JSON.stringify({ a: 'Alpha', b: 'Beta' }),
    });
    const store = createSessionNameStore(storage);
    store.set('a', '   ');
    expect(store.all()).toEqual({ b: 'Beta' });
  });

  it('removes a name', () => {
    const storage = memoryStorage({
      [SESSION_NAMES_KEY]: JSON.stringify({ a: 'Alpha', b: 'Beta' }),
    });
    const store = createSessionNameStore(storage);
    store.remove('a');
    expect(store.all()).toEqual({ b: 'Beta' });
  });

  it('honours a custom storage key', () => {
    const storage = memoryStorage();
    const store = createSessionNameStore(storage, 'custom-key');
    store.set('a', 'Alpha');
    expect(storage.raw()['custom-key']).toBe(JSON.stringify({ a: 'Alpha' }));
  });
});

describe('defaultSessionLabel', () => {
  it('formats the ordinal', () => {
    expect(defaultSessionLabel(3)).toBe('Session #3');
  });
});

describe('sessionDisplayName', () => {
  it('returns the trimmed custom name when set', () => {
    expect(sessionDisplayName('  Custom  ', 2)).toBe('Custom');
  });

  it('falls back to the default label for null', () => {
    expect(sessionDisplayName(null, 2)).toBe('Session #2');
  });

  it('falls back to the default label for undefined', () => {
    expect(sessionDisplayName(undefined, 4)).toBe('Session #4');
  });

  it('falls back to the default label for whitespace', () => {
    expect(sessionDisplayName('   ', 5)).toBe('Session #5');
  });
});

describe('sessionWorkTitle', () => {
  it('prefers a custom name over the prompt', () => {
    expect(sessionWorkTitle('  Renamed  ', 'do a thing', null, 1)).toBe('Renamed');
  });

  it('derives a capitalised title from the first prompt line', () => {
    expect(
      sessionWorkTitle(null, 'add retry logic to the client\nmore detail', null, 1),
    ).toBe('Add retry logic to the client');
  });

  it('strips polite boilerplate prefixes', () => {
    expect(sessionWorkTitle(null, 'Please fix the flaky test', null, 1)).toBe(
      'Fix the flaky test',
    );
  });

  it('collapses whitespace and truncates long prompts with an ellipsis', () => {
    const prompt = 'Analyze the attached pull-request review request and respond in detail';
    const title = sessionWorkTitle(null, prompt, null, 1, 20);
    expect(title.length).toBe(20);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to the default label when there is no prompt', () => {
    expect(sessionWorkTitle(null, '', null, 7)).toBe('Session #7');
    expect(sessionWorkTitle(null, '   \n  ', null, 8)).toBe('Session #8');
  });

  it('uses the CLI-history work title when the launch prompt is empty', () => {
    expect(
      sessionWorkTitle(null, '', 'investigate usage rows\nextra detail', 3),
    ).toBe('Investigate usage rows');
  });
});
