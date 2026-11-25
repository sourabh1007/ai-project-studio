import { z } from 'zod';

export const PLANNER_TRACKING_NAMESPACE = 'planner-tracking';
export const plannerTrackingConfigSchema = z.object({
  enabled: z.boolean(),
  pollMs: z.number().int().min(5000).max(300000),
  retryMs: z.number().int().min(10000).max(3600000),
  timeoutMs: z.number().int().min(5000).max(300000),
  lookbackHours: z.number().int().min(1).max(168),
});
export type PlannerTrackingConfig = z.infer<typeof plannerTrackingConfigSchema>;
export const plannerTrackingDefaults: PlannerTrackingConfig = {
  enabled: true, pollMs: 15000, retryMs: 60000, timeoutMs: 60000, lookbackHours: 24,
};
