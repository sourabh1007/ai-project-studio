import { describe, expect, it, vi } from 'vitest';
import type { PrReview, PrReviewRepo } from '../pr-review/pr-review-contract.js';
import { createReviewBoardQueue } from './review-board-queue.js';
import { createReviewBoardRoutes } from '../api/review-board-controller.js';
import type { ReviewBoardService } from './review-board-contract.js';

describe('persisted import review queue', () => {
  it('restores only explicit import intent, never infers reruns from failures, and survives recreation', () => {
    const review = (id: string, pending?: boolean, message?: string): PrReview => ({
      featureId: id, reviewBoardPending: pending,
      changeGraph: { status: 'failed', failure: message ? { message, failedAt: '' } : null },
    } as PrReview);
    const entries = new Map([
      ['new', review('new', true)],
      ['old', review('old', undefined, 'Background analysis cancelled during app shutdown.')],
      ['restart', review('restart', undefined, 'Interrupted by a restart before it finished. Retry to regenerate.')],
      ['done', review('done', false)],
      ['broken', review('broken', undefined, 'Permission denied')],
      ['empty', review('empty')],
      ['ready', { ...review('ready'), changeGraph: { status: 'ready' } } as PrReview],
    ]);
    const repo: PrReviewRepo = {
      get: (id) => entries.get(id) ?? null, listAll: () => [...entries.values()],
      save: (item) => { entries.set(item.featureId, item); }, delete: vi.fn(),
      findFeatureByPull: vi.fn(),
    };
    const queue = createReviewBoardQueue(repo);
    expect(queue.pending()).toEqual(['new']);
    queue.settle('new');
    queue.settle('missing');
    expect(createReviewBoardQueue(repo).pending()).toEqual([]);
    const routes = createReviewBoardRoutes({ reviewBoard: {} as ReviewBoardService, reviewQueue: queue });
    const req = { params: { featureId: 'old' }, query: {}, body: undefined };
    expect(routes.find((r) => r.path === '/review-board/queue')!.handler(req)).toEqual({ status: 200, body: [] });
    expect(routes.find((r) => r.path.endsWith('/queue/settle'))!.handler(req)).toEqual({ status: 200, body: { settled: true } });
    expect(queue.pending()).toEqual([]);
  });
});
