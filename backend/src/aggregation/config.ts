import { z } from 'zod';

/** Configuration schema for the aggregation (read-side rollup) module. */
export const AGGREGATION_NAMESPACE = 'aggregation';

export const aggregationConfigSchema = z.object({
  /** Session kinds included in cost rollups. */
  rollupKinds: z.array(z.enum(['dev', 'meta'])).min(1),
});

export type AggregationConfig = z.infer<typeof aggregationConfigSchema>;

export const aggregationDefaults: AggregationConfig = {
  rollupKinds: ['dev', 'meta'],
};
