import { z } from 'zod';

/** Configuration schema for the Project Review Board module. */
export const REVIEW_BOARD_NAMESPACE = 'reviewBoard';

export const reviewBoardConfigSchema = z.object({
  /**
   * A trimmed PR description shorter than this many characters is flagged as
   * missing/minimal by the Problem ↔ Solution perspective.
   */
  minDescriptionChars: z.number().int().positive(),
  /**
   * Blast-radius breadth (touched components + config systems + runtime areas)
   * at or above this is treated as at least medium risk.
   */
  blastRadiusMediumThreshold: z.number().int().positive(),
  /** Blast-radius breadth at or above this is treated as high risk. */
  blastRadiusHighThreshold: z.number().int().positive(),
  /**
   * The largest slice of change context (description + change-graph summary)
   * embedded into an AI prompt, in characters — keeps prompts inside provider
   * limits.
   */
  maxContextChars: z.number().int().positive(),
  /** Per-AI-step wall-clock budget in milliseconds before it fails fast. */
  stepTimeoutMs: z.number().int().positive(),
  /** How many times a *transient* provider failure is retried per AI step. */
  transientRetryAttempts: z.number().int().nonnegative(),
  /** Delay before a transient-failure retry, in milliseconds. */
  transientRetryBackoffMs: z.number().int().nonnegative(),
  /** Upper bound on AI findings kept per perspective, newest wins. */
  maxFindingsPerPerspective: z.number().int().positive(),
  /**
   * Largest prompt (characters) delivered inline as a CLI argument on the cold
   * path. At or below this, the prompt is passed directly — bypassing the
   * temporary-file attachment (which some environments' content-access policies
   * block). Above it, the attachment fallback is used to stay within the OS
   * command-line length limit. Kept safely under the ~32K Windows limit.
   */
  coldInlineMaxChars: z.number().int().positive(),
});

export type ReviewBoardConfig = z.infer<typeof reviewBoardConfigSchema>;

export const reviewBoardDefaults: ReviewBoardConfig = {
  minDescriptionChars: 30,
  blastRadiusMediumThreshold: 3,
  blastRadiusHighThreshold: 6,
  maxContextChars: 20_000,
  stepTimeoutMs: 120_000,
  transientRetryAttempts: 2,
  transientRetryBackoffMs: 2_000,
  maxFindingsPerPerspective: 6,
  coldInlineMaxChars: 30_000,
};
