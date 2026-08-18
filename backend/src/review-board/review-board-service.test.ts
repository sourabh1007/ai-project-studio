import { describe, expect, it, vi } from 'vitest';
import { createClock } from '../kernel/clock.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import { reviewBoardDefaults } from './config.js';
import { createReviewBoardService } from './review-board-service.js';

function step(status: PrReview['problemStatement']['status']) {
  return {
    status,
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
  };
}

const review: PrReview = {
  featureId: 'f9',
  repoId: 'r1',
  pull: { number: 42, title: 'Add caching', url: 'https://example.com/pr/42' },
  worktreePath: 'C:/work/pr-42',
  baseBranch: 'main',
  description: 'short',
  problemStatement: { ...step('ready'), content: 'p', sufficient: true },
  changeGraph: {
    ...step('ready'),
    projects: [{ id: 'p1', name: 'Cache', path: 'svc/cache.csproj' }],
    nodes: [
      {
        path: 'svc/cache.cs',
        projectId: 'p1',
        module: 'Cache',
        category: 'code',
        kind: 'changed',
        changeKind: 'modified',
        diff: '@@',
        whatItDoes: 'x',
        whatChanged: 'y',
        review: [],
      },
    ],
    edges: [],
  },
  changedFiles: 1,
  timestamps: { createdAt: '', updatedAt: '' },
};

describe('createReviewBoardService', () => {
  it('derives a board from the feature PR review', () => {
    const clock = createClock(() => Date.parse('2026-02-02T00:00:00.000Z'));
    const service = createReviewBoardService({
      reviews: { get: () => review },
      config: reviewBoardDefaults,
      clock,
    });

    const board = service.get('f9');
    expect(board.featureId).toBe('f9');
    expect(board.pull.number).toBe(42);
    expect(board.model.projectType).toBe('Backend service');
    expect(board.generatedAt).toBe('2026-02-02T00:00:00.000Z');
    // short description → problem-solution warning
    const problem = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(problem?.status).toBe('warning');
  });

  it('handles a review with no changed files count', () => {
    const clock = createClock(() => 0);
    const service = createReviewBoardService({
      reviews: { get: () => ({ ...review, changedFiles: null }) },
      config: reviewBoardDefaults,
      clock,
    });
    expect(service.get('f9').changedFiles).toBe(0);
  });

  it('propagates a missing-review error from the port', () => {
    const clock = createClock(() => 0);
    const boom = new Error('no review');
    const get = vi.fn(() => {
      throw boom;
    });
    const service = createReviewBoardService({
      reviews: { get },
      config: reviewBoardDefaults,
      clock,
    });
    expect(() => service.get('missing')).toThrow('no review');
  });
});
