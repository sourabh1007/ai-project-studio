import { describe, expect, it } from 'vitest';
import { analysisFailureCause } from './analysis-failure.js';

describe('analysisFailureCause', () => {
  it('returns null when nothing carries a message', () => {
    expect(analysisFailureCause([null, undefined, '   '])).toBeNull();
  });

  it('reports a single shared cause once', () => {
    expect(
      analysisFailureCause(['Backend stopped', 'Backend stopped', null]),
    ).toBe('Backend stopped');
  });

  it('names the first cause and counts one other', () => {
    expect(analysisFailureCause(['Backend stopped', 'Timed out'])).toBe(
      'Backend stopped (and 1 other cause)',
    );
  });

  it('counts several other causes', () => {
    expect(analysisFailureCause(['a', 'b', 'c'])).toBe(
      'a (and 2 other causes)',
    );
  });
});
