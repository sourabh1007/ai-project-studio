import { z } from 'zod';
import {
  DEFAULT_PERSPECTIVE_PROMPT_TEMPLATE,
  DEFAULT_PROBLEM_SOLUTION_PROMPT_TEMPLATE,
} from './review-board-prompt.js';

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
  /**
   * Per-AI-step wall-clock budget in milliseconds before it fails fast.
   *
   * A review-board perspective embeds change-graph + diff evidence and runs a
   * full analytical turn, which is observed to take ~100s. The old 120s budget
   * left almost no headroom, so ordinary variance (a slightly larger diff, a
   * busy pool) pushed turns past it and they were killed with no durable result
   * ("Provider timed out after 120000ms"). This is aligned with the warm pool's
   * own `turnTimeoutMs` and the meta runner's `timeoutMs` (both 300s) so the
   * step budget is no longer the binding constraint; a genuinely wedged turn
   * still surfaces as a failure, just with room for a legitimately slow one to
   * finish first.
   */
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
  /**
   * Prompt template that runs a review through ONE generic perspective/lens.
   * Editable from Settings → Prompts & Commands. Placeholders (all required for
   * the run to have full evidence): {{lensName}}, {{lensPurpose}}, {{prNumber}},
   * {{prTitle}}, {{baseBranch}}, {{filesChanged}}, {{description}},
   * {{modelDigest}}, {{changedFiles}}.
   */
  perspectivePromptTemplate: z.string().min(1),
  /**
   * Prompt template for the dedicated Problem ↔ Solution lens — a general,
   * plain-English "does the solution solve the problem?" judgement. Editable
   * from Settings → Prompts & Commands. Placeholders: {{prNumber}}, {{prTitle}},
   * {{filesChanged}}, {{description}}, {{distilledProblem}}, {{solutionDigest}}.
   */
  problemSolutionPromptTemplate: z.string().min(1),
});

export type ReviewBoardConfig = z.infer<typeof reviewBoardConfigSchema>;

export const reviewBoardDefaults: ReviewBoardConfig = {
  minDescriptionChars: 30,
  blastRadiusMediumThreshold: 3,
  blastRadiusHighThreshold: 6,
  maxContextChars: 20_000,
  stepTimeoutMs: 300_000,
  transientRetryAttempts: 2,
  transientRetryBackoffMs: 2_000,
  maxFindingsPerPerspective: 6,
  coldInlineMaxChars: 30_000,
  perspectivePromptTemplate: DEFAULT_PERSPECTIVE_PROMPT_TEMPLATE,
  problemSolutionPromptTemplate: DEFAULT_PROBLEM_SOLUTION_PROMPT_TEMPLATE,
};
