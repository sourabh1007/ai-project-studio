import { z } from 'zod';

/** Configuration schema for the PR review module. */
export const PR_REVIEW_NAMESPACE = 'prReview';

export const prReviewConfigSchema = z.object({
  /** Max characters of repository context embedded in the review prompt. */
  maxContextChars: z.number().int().positive(),
  /** Max characters of the unified diff embedded in the review prompt. */
  maxPatchChars: z.number().int().positive(),
});

export type PrReviewConfig = z.infer<typeof prReviewConfigSchema>;

export const prReviewDefaults: PrReviewConfig = {
  maxContextChars: 20_000,
  maxPatchChars: 60_000,
};
