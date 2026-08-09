import { z } from 'zod';

/** Configuration schema for the PR review module. */
export const PR_REVIEW_NAMESPACE = 'prReview';

export const prReviewConfigSchema = z.object({
  /** Max characters of repository context embedded in the review prompt. */
  maxContextChars: z.number().int().positive(),
  /** Max characters of the unified diff embedded in the review prompt. */
  maxPatchChars: z.number().int().positive(),
  /**
   * Max characters retained for each file's isolated per-file diff, shown when
   * a change-graph node is selected. Bounds the persisted document and keeps a
   * single huge file from dominating the review payload.
   */
  maxFileDiffChars: z.number().int().positive(),
  /**
   * Per-step hard timeout (ms). Each step is a tool-less, single-shot
   * completion, so it should finish quickly; this bounds it well under the
   * generic metasession ceiling so a stall surfaces as a failed step fast
   * instead of an endless "Analyzing…" spinner.
   */
  stepTimeoutMs: z.number().int().positive(),
});

export type PrReviewConfig = z.infer<typeof prReviewConfigSchema>;

export const prReviewDefaults: PrReviewConfig = {
  maxContextChars: 20_000,
  maxPatchChars: 60_000,
  maxFileDiffChars: 8_000,
  stepTimeoutMs: 120_000,
};
