import { z } from 'zod';

export const META_OPERATIONS_NAMESPACE = 'metaOperations';
export const metaOperationsConfigSchema = z.object({
  defaultPageSize: z.number().int().min(1).max(1000),
  maxPageSize: z.number().int().min(1).max(1000),
  recoveryPageSize: z.number().int().min(1).max(1000),
}).refine((config) => config.defaultPageSize <= config.maxPageSize, 'Default page size exceeds maximum');
export type MetaOperationsConfig = z.infer<typeof metaOperationsConfigSchema>;
export const metaOperationsDefaults: MetaOperationsConfig = {
  defaultPageSize: 25, maxPageSize: 100, recoveryPageSize: 100,
};
