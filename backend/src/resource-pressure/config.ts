import { z } from 'zod';

export const RESOURCE_PRESSURE_NAMESPACE = 'resourcePressure';

export const resourcePressureConfigSchema = z.object({
  sampleIntervalMs: z.number().int().min(250),
  staleAfterMs: z.number().int().positive(),
  highCpuPercent: z.number().positive().max(100),
  lowFreeMemoryPercent: z.number().positive().max(100),
  highEventLoopDelayMs: z.number().positive(),
}).refine((value) => value.staleAfterMs >= value.sampleIntervalMs, {
  message: 'staleAfterMs must cover at least one sampling interval',
});

export type ResourcePressureConfig = z.infer<typeof resourcePressureConfigSchema>;

export const resourcePressureDefaults: ResourcePressureConfig = {
  sampleIntervalMs: 2_000,
  staleAfterMs: 30_000,
  highCpuPercent: 90,
  lowFreeMemoryPercent: 10,
  highEventLoopDelayMs: 250,
};
