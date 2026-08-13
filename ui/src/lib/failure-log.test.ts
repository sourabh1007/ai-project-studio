import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFailure,
  listFailures,
  clearFailures,
  MAX_FAILURES,
} from './failure-log';

describe('failure-log', () => {
  beforeEach(() => {
    clearFailures();
  });

  it('records a failure at the front, newest first', () => {
    recordFailure('A', new Error('first'));
    recordFailure('B', new Error('second'));
    const list = listFailures();
    expect(list).toHaveLength(2);
    expect(list[0].context).toBe('B');
    expect(list[0].message).toBe('second');
    expect(list[1].context).toBe('A');
    expect(typeof list[0].at).toBe('string');
  });

  it('extracts the message from Error, string, and other values', () => {
    const err = recordFailure('ctx', new Error('boom'));
    expect(err.message).toBe('boom');
    const str = recordFailure('ctx', 'plain string');
    expect(str.message).toBe('plain string');
    const other = recordFailure('ctx', { code: 42 });
    expect(other.message).toBe(String({ code: 42 }));
  });

  it('caps the buffer at MAX_FAILURES, dropping the oldest', () => {
    for (let i = 0; i < MAX_FAILURES + 5; i += 1) {
      recordFailure('loop', new Error(`e${i}`));
    }
    const list = listFailures();
    expect(list).toHaveLength(MAX_FAILURES);
    // Newest first: the last recorded should be at the front.
    expect(list[0].message).toBe(`e${MAX_FAILURES + 4}`);
    // The oldest surviving is e5 (e0..e4 were dropped).
    expect(list[list.length - 1].message).toBe('e5');
  });

  it('clears all recorded failures', () => {
    recordFailure('ctx', new Error('x'));
    expect(listFailures()).toHaveLength(1);
    clearFailures();
    expect(listFailures()).toHaveLength(0);
  });
});
