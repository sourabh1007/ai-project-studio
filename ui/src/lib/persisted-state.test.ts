import { describe, it, expect, vi } from 'vitest';
import {
  readPersisted,
  writePersisted,
  clampNumber,
  isFiniteNumber,
  isNonEmptyString,
  isOneOf,
  type KeyValueStore,
} from './persisted-state.js';

/** An in-memory store with optional throwing behavior for edge-case tests. */
function fakeStore(
  initial: Record<string, string> = {},
  opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {},
): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      if (opts.throwOnGet) throw new Error('blocked');
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key, value) {
      if (opts.throwOnSet) throw new Error('quota');
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

describe('readPersisted', () => {
  it('returns the parsed value when valid', () => {
    const store = fakeStore({ k: JSON.stringify(42) });
    expect(readPersisted(store, 'k', isFiniteNumber, 0)).toBe(42);
  });

  it('returns the fallback when the key is missing', () => {
    expect(readPersisted(fakeStore(), 'k', isFiniteNumber, 7)).toBe(7);
  });

  it('returns the fallback when JSON is corrupt', () => {
    const store = fakeStore({ k: 'not json{' });
    expect(readPersisted(store, 'k', isFiniteNumber, 7)).toBe(7);
  });

  it('returns the fallback when validation fails', () => {
    const store = fakeStore({ k: JSON.stringify('nope') });
    expect(readPersisted(store, 'k', isFiniteNumber, 7)).toBe(7);
  });

  it('returns the fallback when getItem throws', () => {
    const store = fakeStore({}, { throwOnGet: true });
    expect(readPersisted(store, 'k', isFiniteNumber, 7)).toBe(7);
  });
});

describe('writePersisted', () => {
  it('writes JSON and returns true on success', () => {
    const store = fakeStore();
    expect(writePersisted(store, 'k', { a: 1 })).toBe(true);
    expect(store.getItem('k')).toBe(JSON.stringify({ a: 1 }));
  });

  it('returns false when setItem throws', () => {
    const store = fakeStore({}, { throwOnSet: true });
    expect(writePersisted(store, 'k', 1)).toBe(false);
  });
});

describe('clampNumber', () => {
  it('clamps below the minimum', () => {
    expect(clampNumber(-5, 0, 10)).toBe(0);
  });
  it('clamps above the maximum', () => {
    expect(clampNumber(99, 0, 10)).toBe(10);
  });
  it('passes through an in-range value', () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
  });
  it('returns the minimum for NaN', () => {
    expect(clampNumber(Number.NaN, 3, 10)).toBe(3);
  });
});

describe('type guards', () => {
  it('isFiniteNumber accepts finite numbers only', () => {
    expect(isFiniteNumber(1)).toBe(true);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
  });

  it('isNonEmptyString accepts non-empty strings only', () => {
    expect(isNonEmptyString('x')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString(1)).toBe(false);
  });

  it('isOneOf restricts to the allow-list', () => {
    const guard = isOneOf(['a', 'b'] as const);
    expect(guard('a')).toBe(true);
    expect(guard('c')).toBe(false);
    expect(guard(3)).toBe(false);
  });
});

describe('vi sanity — spy on a store', () => {
  it('writes exactly once per call', () => {
    const setItem = vi.fn();
    const store: KeyValueStore = {
      getItem: () => null,
      setItem,
      removeItem: () => {},
    };
    writePersisted(store, 'k', 1);
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});
