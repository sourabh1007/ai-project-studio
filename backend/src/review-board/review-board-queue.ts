import type { PrReviewRepo } from '../pr-review/pr-review-contract.js';

/** Intent lives with the PR, not in localStorage on a changing localhost port. */
export function createReviewBoardQueue(reviews: PrReviewRepo) {
  return {
    pending(): string[] {
      return reviews.listAll().filter((review) => review.reviewBoardPending === true)
        .map((review) => review.featureId);
    },
    settle(featureId: string): void {
      const review = reviews.get(featureId);
      if (review) reviews.save({ ...review, reviewBoardPending: false });
    },
  };
}
export type ReviewBoardQueue = ReturnType<typeof createReviewBoardQueue>;
