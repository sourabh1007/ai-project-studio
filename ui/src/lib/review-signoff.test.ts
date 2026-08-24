import { describe, expect, it } from 'vitest';
import {
  allPerspectivesReviewed,
  clearPerspectivesReviewed,
  emptySignoff,
  isPerspectiveReviewed,
  parseSignoff,
  perspectiveBadgeLabel,
  perspectiveVerdictLabel,
  reviewedCount,
  withPerspectiveReviewed,
  withPrReviewCleared,
  withPrReviewed,
} from './review-signoff.js';

const AT = '2024-01-01T00:00:00.000Z';
const AT2 = '2024-02-02T00:00:00.000Z';

describe('emptySignoff', () => {
  it('starts with nothing reviewed', () => {
    const s = emptySignoff();
    expect(s.perspectives).toEqual({});
    expect(s.prReviewedAt).toBeNull();
  });
});

describe('isPerspectiveReviewed / reviewedCount', () => {
  it('reflects which perspectives are signed off', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(isPerspectiveReviewed(s, 'a')).toBe(true);
    expect(isPerspectiveReviewed(s, 'b')).toBe(false);
    expect(reviewedCount(s, ['a', 'b', 'c'])).toBe(1);
  });
});

describe('allPerspectivesReviewed', () => {
  it('is false for an empty board', () => {
    expect(allPerspectivesReviewed(emptySignoff(), [])).toBe(false);
  });

  it('is true only when every perspective is signed off', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(allPerspectivesReviewed(s, ['a', 'b'])).toBe(false);
    s = withPerspectiveReviewed(s, 'b', AT);
    expect(allPerspectivesReviewed(s, ['a', 'b'])).toBe(true);
  });
});

describe('withPerspectiveReviewed', () => {
  it('sets a sign-off with the given timestamp', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(s.perspectives.a).toBe(AT);
  });

  it('clearing a sign-off also invalidates a PR sign-off', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    s = withPrReviewed(s, ['a'], AT2);
    expect(s.prReviewedAt).toBe(AT2);
    const cleared = withPerspectiveReviewed(s, 'a', null);
    expect(cleared.perspectives.a).toBeUndefined();
    expect(cleared.prReviewedAt).toBeNull();
  });
});

describe('clearPerspectivesReviewed', () => {
  it('is a no-op for an empty id list', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(clearPerspectivesReviewed(s, [])).toBe(s);
  });

  it('returns the same state when nothing changes', () => {
    const s = emptySignoff();
    expect(clearPerspectivesReviewed(s, ['x', 'y'])).toBe(s);
  });

  it('clears the listed perspectives and any PR sign-off', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    s = withPerspectiveReviewed(s, 'b', AT);
    s = withPrReviewed(s, ['a', 'b'], AT2);
    const cleared = clearPerspectivesReviewed(s, ['a']);
    expect(cleared.perspectives.a).toBeUndefined();
    expect(cleared.perspectives.b).toBe(AT);
    expect(cleared.prReviewedAt).toBeNull();
  });

  it('clears a stale PR sign-off even when no perspective ids match', () => {
    const s = { perspectives: {}, prReviewedAt: AT2 };
    const cleared = clearPerspectivesReviewed(s, ['ghost']);
    expect(cleared.prReviewedAt).toBeNull();
  });
});

describe('withPrReviewed', () => {
  it('refuses unless every perspective is signed off', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(withPrReviewed(s, ['a', 'b'], AT2)).toBe(s);
  });

  it('marks the PR reviewed when all perspectives are signed off', () => {
    const s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    expect(withPrReviewed(s, ['a'], AT2).prReviewedAt).toBe(AT2);
  });
});

describe('withPrReviewCleared', () => {
  it('is a no-op when the PR is not reviewed', () => {
    const s = emptySignoff();
    expect(withPrReviewCleared(s)).toBe(s);
  });

  it('clears an existing PR sign-off', () => {
    let s = withPerspectiveReviewed(emptySignoff(), 'a', AT);
    s = withPrReviewed(s, ['a'], AT2);
    expect(withPrReviewCleared(s).prReviewedAt).toBeNull();
  });
});

describe('perspectiveVerdictLabel', () => {
  it('maps machine statuses to reviewer wording', () => {
    expect(perspectiveVerdictLabel('approved')).toBe('Approve');
    expect(perspectiveVerdictLabel('not-applicable')).toBe('Not applicable');
    expect(perspectiveVerdictLabel('not-started')).toBe('Not started');
    expect(perspectiveVerdictLabel('warning')).toBe('Needs attention');
    expect(perspectiveVerdictLabel('blocked')).toBe('Needs attention');
    expect(perspectiveVerdictLabel('needs-review')).toBe('Needs attention');
  });
});

describe('perspectiveBadgeLabel', () => {
  it('reads "Reviewing" while analysing', () => {
    expect(perspectiveBadgeLabel(true, 'approved')).toBe('Reviewing');
  });

  it('otherwise collapses to the verdict wording', () => {
    expect(perspectiveBadgeLabel(false, 'approved')).toBe('Approve');
    expect(perspectiveBadgeLabel(false, 'blocked')).toBe('Needs attention');
  });
});

describe('parseSignoff', () => {
  it('returns empty for non-objects', () => {
    expect(parseSignoff(null)).toEqual(emptySignoff());
    expect(parseSignoff('nope')).toEqual(emptySignoff());
    expect(parseSignoff(42)).toEqual(emptySignoff());
  });

  it('keeps only string perspective timestamps', () => {
    const parsed = parseSignoff({
      perspectives: { a: AT, b: 0, c: '', d: null },
      prReviewedAt: AT2,
    });
    expect(parsed.perspectives).toEqual({ a: AT });
    expect(parsed.prReviewedAt).toBe(AT2);
  });

  it('defaults a missing/blank prReviewedAt to null', () => {
    expect(parseSignoff({ perspectives: {} }).prReviewedAt).toBeNull();
    expect(parseSignoff({ prReviewedAt: '' }).prReviewedAt).toBeNull();
    expect(parseSignoff({ perspectives: 'bad' }).perspectives).toEqual({});
  });
});
