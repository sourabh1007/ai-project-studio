import { z } from 'zod';

/** Configuration schema for bounded app-level lifecycle coordination. */
export const LIFECYCLE_NAMESPACE = 'lifecycle';

export const lifecycleConfigSchema = z.object({
  /** How many unfinished ended-session captures to revisit on each recovery tick. */
  stoppedCaptureRecoveryPageSize: z.number().int().positive().max(1000),
  /** Cadence (ms) for the shared ended-session recovery loop. */
  stoppedCaptureRecoveryIntervalMs: z.number().int().positive().max(2_147_483_647),
});

export type LifecycleConfig = z.infer<typeof lifecycleConfigSchema>;

export const lifecycleDefaults: LifecycleConfig = {
  stoppedCaptureRecoveryPageSize: 8,
  stoppedCaptureRecoveryIntervalMs: 1500,
};
