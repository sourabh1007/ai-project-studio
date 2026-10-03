import { z } from 'zod';

/** Configuration schema for the system-health module. */
export const HEALTH_NAMESPACE = 'health';

export const healthConfigSchema = z.object({
  /**
   * Upper bound on a single subsystem probe. A probe that exceeds this is
   * reported as `down` ("timed out") so one stuck subsystem can never hang the
   * whole health report.
   */
  probeTimeoutMs: z.number().int().positive(),
});

export type HealthConfig = z.infer<typeof healthConfigSchema>;

export const healthDefaults: HealthConfig = {
  probeTimeoutMs: 2000,
};
