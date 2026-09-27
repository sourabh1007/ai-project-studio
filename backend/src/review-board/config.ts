import { z } from 'zod';
import {
  DEFAULT_COMMON_REVIEW_GUIDANCE,
  DEFAULT_PERSPECTIVE_PROMPTS,
} from './review-board-perspective-prompts.js';

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
   * Section 1 — the shared review guidance every perspective prompt opens with:
   * how to review (concise, evidence-tied, single-lens) and the language/config
   * coverage note. Editable from the Review Board agent settings. Placeholders:
   * {{lensName}}, {{lensPurpose}}, {{prNumber}}, {{prTitle}}, {{baseBranch}},
   * {{filesChanged}}, {{description}}, {{modelDigest}}, {{changedFiles}}.
   */
  commonReviewGuidance: z.string().min(1),

  // Section 2 (focus) + Section 3 (issue format) per perspective. Each lens has
  // its own bespoke pair, editable from the Review Board agent settings, so the
  // emphasis of each review can be tuned independently. The machine-readable
  // response envelope is appended by the assembler and is intentionally NOT
  // configurable, so an edit can never break parsing.
  problemSolutionFocus: z.string().min(1),
  problemSolutionIssueFormat: z.string().min(1),
  architectureFocus: z.string().min(1),
  architectureIssueFormat: z.string().min(1),
  impactBlastRadiusFocus: z.string().min(1),
  impactBlastRadiusIssueFormat: z.string().min(1),
  codeQualityFocus: z.string().min(1),
  codeQualityIssueFormat: z.string().min(1),
  performanceFocus: z.string().min(1),
  performanceIssueFormat: z.string().min(1),
  observabilityFocus: z.string().min(1),
  observabilityIssueFormat: z.string().min(1),
  configurationFocus: z.string().min(1),
  configurationIssueFormat: z.string().min(1),
  apiContractFocus: z.string().min(1),
  apiContractIssueFormat: z.string().min(1),
  accessibilityFocus: z.string().min(1),
  accessibilityIssueFormat: z.string().min(1),
  backwardCompatibilityFocus: z.string().min(1),
  backwardCompatibilityIssueFormat: z.string().min(1),
  dataContractFocus: z.string().min(1),
  dataContractIssueFormat: z.string().min(1),
  rollbackSafetyFocus: z.string().min(1),
  rollbackSafetyIssueFormat: z.string().min(1),
  deploymentFocus: z.string().min(1),
  deploymentIssueFormat: z.string().min(1),
  testingFocus: z.string().min(1),
  testingIssueFormat: z.string().min(1),
  securityFocus: z.string().min(1),
  securityIssueFormat: z.string().min(1),
  finalDecisionFocus: z.string().min(1),
  finalDecisionIssueFormat: z.string().min(1),
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

  commonReviewGuidance: DEFAULT_COMMON_REVIEW_GUIDANCE,

  problemSolutionFocus: DEFAULT_PERSPECTIVE_PROMPTS['problem-solution'].focus,
  problemSolutionIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['problem-solution'].issueFormat,
  architectureFocus: DEFAULT_PERSPECTIVE_PROMPTS.architecture.focus,
  architectureIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS.architecture.issueFormat,
  impactBlastRadiusFocus:
    DEFAULT_PERSPECTIVE_PROMPTS['impact-blast-radius'].focus,
  impactBlastRadiusIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['impact-blast-radius'].issueFormat,
  codeQualityFocus: DEFAULT_PERSPECTIVE_PROMPTS['code-quality'].focus,
  codeQualityIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['code-quality'].issueFormat,
  performanceFocus: DEFAULT_PERSPECTIVE_PROMPTS.performance.focus,
  performanceIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS.performance.issueFormat,
  observabilityFocus: DEFAULT_PERSPECTIVE_PROMPTS.observability.focus,
  observabilityIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS.observability.issueFormat,
  configurationFocus: DEFAULT_PERSPECTIVE_PROMPTS.configuration.focus,
  configurationIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS.configuration.issueFormat,
  apiContractFocus: DEFAULT_PERSPECTIVE_PROMPTS['api-contract'].focus,
  apiContractIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['api-contract'].issueFormat,
  accessibilityFocus: DEFAULT_PERSPECTIVE_PROMPTS.accessibility.focus,
  accessibilityIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS.accessibility.issueFormat,
  backwardCompatibilityFocus:
    DEFAULT_PERSPECTIVE_PROMPTS['backward-compatibility'].focus,
  backwardCompatibilityIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['backward-compatibility'].issueFormat,
  dataContractFocus: DEFAULT_PERSPECTIVE_PROMPTS['data-contract'].focus,
  dataContractIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['data-contract'].issueFormat,
  rollbackSafetyFocus: DEFAULT_PERSPECTIVE_PROMPTS['rollback-safety'].focus,
  rollbackSafetyIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['rollback-safety'].issueFormat,
  deploymentFocus: DEFAULT_PERSPECTIVE_PROMPTS.deployment.focus,
  deploymentIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS.deployment.issueFormat,
  testingFocus: DEFAULT_PERSPECTIVE_PROMPTS.testing.focus,
  testingIssueFormat: DEFAULT_PERSPECTIVE_PROMPTS.testing.issueFormat,
  securityFocus: DEFAULT_PERSPECTIVE_PROMPTS.security.focus,
  securityIssueFormat: DEFAULT_PERSPECTIVE_PROMPTS.security.issueFormat,
  finalDecisionFocus: DEFAULT_PERSPECTIVE_PROMPTS['final-decision'].focus,
  finalDecisionIssueFormat:
    DEFAULT_PERSPECTIVE_PROMPTS['final-decision'].issueFormat,
};
