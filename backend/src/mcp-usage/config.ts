import { z } from 'zod';

export const MCP_USAGE_NAMESPACE = 'mcpUsage';
export const mcpUsageConfigSchema = z.object({
  pollIntervalMs: z.number().int().min(1000).max(60000),
  sourcesPerTick: z.number().int().min(1).max(16),
  bytesPerSource: z.number().int().min(4096).max(1048576),
  maxCachedSources: z.number().int().min(16).max(10000),
});
export type McpUsageConfig = z.infer<typeof mcpUsageConfigSchema>;
export const mcpUsageDefaults: McpUsageConfig = {
  pollIntervalMs: 1500,
  sourcesPerTick: 8,
  bytesPerSource: 262144,
  maxCachedSources: 4096,
};
