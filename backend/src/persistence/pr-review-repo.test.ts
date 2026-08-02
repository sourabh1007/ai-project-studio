import { describe, expect, it } from 'vitest';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import { createDatabase } from './db/connection.js';
import { createPrReviewRepo } from './pr-review-repo.js';

function review(overrides: Partial<PrReview> = {}): PrReview {
  return {
    featureId: 'f1',
    repoId: 'r1',
    pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
    worktreePath: 'C:\\work\\pr-7',
    baseBranch: 'main',
    status: 'ready',
    summary: 'Adds retry logic.',
    coreAnalysis: '- wraps the client',
    changedFiles: 3,
    timestamps: {
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      generatedAt: '2026-08-01T00:01:00.000Z',
    },
    failure: null,
    ...overrides,
  };
}

describe('pr-review-repo', () => {
  it('saves, loads and deletes a ready review', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);

    expect(reviews.get('missing')).toBeNull();
    reviews.save(review());
    expect(reviews.get('f1')).toEqual(review());

    reviews.delete('f1');
    expect(reviews.get('f1')).toBeNull();
  });

  it('round-trips a generating review with null fields and a failure', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const reviews = createPrReviewRepo(db);

    const generating = review({
      status: 'generating',
      summary: null,
      coreAnalysis: null,
      changedFiles: null,
      baseBranch: null,
      timestamps: {
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        generatedAt: null,
      },
    });
    reviews.save(generating);
    expect(reviews.get('f1')).toEqual(generating);

    const failed = review({
      status: 'failed',
      summary: null,
      coreAnalysis: null,
      changedFiles: null,
      timestamps: {
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:02:00.000Z',
        generatedAt: null,
      },
      failure: { message: 'provider exited 1', failedAt: '2026-08-01T00:02:00.000Z' },
    });
    reviews.save(failed);
    expect(reviews.get('f1')).toEqual(failed);
  });
});
