import { z } from 'zod';

/**
 * Configuration for the plan-usage module, which surfaces the signed-in
 * Copilot plan's AI-credit budget scraped from the CLI `/usage` panel. The
 * single knob is how often that (multi-second) capture may run: it bounds both
 * the backend cache lifetime and the UI status-bar poll, so one control governs
 * the whole refresh cadence.
 */
export const PLAN_USAGE_NAMESPACE = 'planUsage';

export const planUsageConfigSchema = z.object({
  /** Minutes between plan AI-credit refreshes (cache TTL and UI poll). */
  refreshMinutes: z.number().int().min(1),
});

export type PlanUsageConfig = z.infer<typeof planUsageConfigSchema>;

export const planUsageDefaults: PlanUsageConfig = {
  refreshMinutes: 5,
};
