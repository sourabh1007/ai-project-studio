import { z } from 'zod';

/**
 * Configuration for the MCP server management module. MCP file locations and
 * formats are provider-specific and live on each provider's {@link McpSupport};
 * this module only owns whether the surface is exposed.
 */
export const MCP_NAMESPACE = 'mcp';

export const mcpConfigSchema = z.object({
  /** Feature flag for the MCP server management surface. */
  enabled: z.boolean(),
  /**
   * Upper bound (ms) on the provider meta-session used to discover the config
   * file path. Discovery only runs when the documented default file is absent,
   * and a slow/hung CLI must never block the UI, so it is timed out.
   */
  discoveryTimeoutMs: z.number().int().positive(),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

export const mcpDefaults: McpConfig = {
  enabled: true,
  discoveryTimeoutMs: 15_000,
};
