import { describe, it, expect } from 'vitest';
import {
  reviewAgeMs,
  formatReviewAge,
  compareByReviewAge,
  oldestCreatedAt,
} from './pr-review-age.js';

const NOW = Date.parse('2024-06-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('reviewAgeMs', () => {
  it('returns null for missing or unparseable timestamps', () => {
    expect(reviewAgeMs(null, NOW)).toBeNull();
    expect(reviewAgeMs(undefined, NOW)).toBeNull();
    expect(reviewAgeMs('', NOW)).toBeNull();
    expect(reviewAgeMs('not-a-date', NOW)).toBeNull();
  });

  it('measures elapsed milliseconds since createdAt', () => {
    expect(reviewAgeMs(ago(3 * HOUR), NOW)).toBe(3 * HOUR);
  });

  it('clamps a future timestamp to zero', () => {
    expect(reviewAgeMs(new Date(NOW + DAY).toISOString(), NOW)).toBe(0);
  });
});

describe('formatReviewAge', () => {
  it('returns null when the age is unknown', () => {
    expect(formatReviewAge(null, NOW)).toBeNull();
    expect(formatReviewAge('nope', NOW)).toBeNull();
  });

  it('renders compact labels across each unit boundary', () => {
    expect(formatReviewAge(ago(30 * 1000), NOW)).toBe('just now');
    expect(formatReviewAge(ago(5 * MIN), NOW)).toBe('5m');
    expect(formatReviewAge(ago(3 * HOUR), NOW)).toBe('3h');
    expect(formatReviewAge(ago(2 * DAY), NOW)).toBe('2d');
    expect(formatReviewAge(ago(6 * WEEK), NOW)).toBe('6w');
  });
});

describe('compareByReviewAge', () => {
  it('orders oldest-first when longest', () => {
    const older = ago(5 * DAY);
    const newer = ago(1 * DAY);
    expect(compareByReviewAge(older, newer, 'longest', NOW)).toBeLessThan(0);
    expect(compareByReviewAge(newer, older, 'longest', NOW)).toBeGreaterThan(0);
  });

  it('orders newest-first when newest', () => {
    const older = ago(5 * DAY);
    const newer = ago(1 * DAY);
    expect(compareByReviewAge(newer, older, 'newest', NOW)).toBeLessThan(0);
    expect(compareByReviewAge(older, newer, 'newest', NOW)).toBeGreaterThan(0);
  });

  it('sorts unknown ages last regardless of order', () => {
    const dated = ago(DAY);
    expect(compareByReviewAge(null, dated, 'longest', NOW)).toBe(1);
    expect(compareByReviewAge(dated, null, 'longest', NOW)).toBe(-1);
    expect(compareByReviewAge(null, null, 'newest', NOW)).toBe(0);
  });
});

describe('oldestCreatedAt', () => {
  it('returns null when no pull carries a timestamp', () => {
    expect(oldestCreatedAt([{}, { createdAt: null }, { createdAt: 'x' }])).toBeNull();
  });

  it('returns the earliest valid timestamp', () => {
    const old = ago(5 * DAY);
    const mid = ago(2 * DAY);
    expect(
      oldestCreatedAt([{ createdAt: mid }, { createdAt: null }, { createdAt: old }]),
    ).toBe(old);
  });
});
