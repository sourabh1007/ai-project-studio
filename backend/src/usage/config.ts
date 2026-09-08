import { z } from 'zod';

/** Configuration schema for the usage module (live per-session meter). */
export const USAGE_NAMESPACE = 'usage';

export const usageConfigSchema = z.object({
  /**
   * Cadence (ms) for polling the CLI's own usage store while a session runs.
   * Drives the live credit/token/model meter for interactive terminal sessions.
   */
  livePollIntervalMs: z.number().int().positive(),
  capturePageSize: z.number().int().positive().max(1000),
  finalDrainPages: z.number().int().positive().max(100),
});

export type UsageConfig = z.infer<typeof usageConfigSchema>;

export const usageDefaults: UsageConfig = {
  livePollIntervalMs: 1500,
  capturePageSize: 128,
  finalDrainPages: 8,
};
