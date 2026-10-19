import { z } from 'zod';

export const SKILL_USAGE_NAMESPACE = 'skillUsage';
export const skillUsageConfigSchema = z.object({
  maxEvents: z.number().int().min(100).max(10000),
});
export type SkillUsageConfig = z.infer<typeof skillUsageConfigSchema>;
export const skillUsageDefaults: SkillUsageConfig = { maxEvents: 5000 };
