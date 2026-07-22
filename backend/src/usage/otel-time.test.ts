import { describe, it, expect } from 'vitest';
import { hrTimeToIso } from './otel-time.js';

describe('otel-time', () => {
  it('converts hrTime to ISO-8601', () => {
    expect(hrTimeToIso([0, 0])).toBe('1970-01-01T00:00:00.000Z');
    expect(hrTimeToIso([1, 500_000_000])).toBe('1970-01-01T00:00:01.500Z');
  });

  it('floors sub-millisecond nanoseconds', () => {
    expect(hrTimeToIso([0, 1_999_999])).toBe('1970-01-01T00:00:00.001Z');
  });
});
