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
});

export type ReviewBoardConfig = z.infer<typeof reviewBoardConfigSchema>;

export const reviewBoardDefaults: ReviewBoardConfig = {
  minDescriptionChars: 30,
  blastRadiusMediumThreshold: 3,
  blastRadiusHighThreshold: 6,
};
