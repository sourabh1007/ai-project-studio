import { z } from 'zod';

/** Configuration for the Planner module. */
export const PLANNER_NAMESPACE = 'planner';

export const plannerConfigSchema = z.object({
  /** Maximum length of a task title. */
  maxTitleLength: z.number().int().positive(),
  /** Maximum length of a task's notes. */
  maxNotesLength: z.number().int().positive(),
  /** Maximum length of a stored pull-request URL. */
  maxPrUrlLength: z.number().int().positive(),
  /** Default priority applied when a task is created without one. */
  defaultPriority: z.enum(['p0', 'p1', 'p2', 'p3']),
});

export type PlannerConfig = z.infer<typeof plannerConfigSchema>;

export const plannerDefaults: PlannerConfig = {
  maxTitleLength: 200,
  maxNotesLength: 10_000,
  maxPrUrlLength: 2_000,
  defaultPriority: 'p2',
};
