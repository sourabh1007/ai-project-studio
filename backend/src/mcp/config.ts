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
  /** Independent, explicitly requested MCP probes; extra requests fail busy instead of queuing. */
  maxConcurrentProbes: z.number().int().positive().optional(),
  /** Each phase of an explicit Studio bridge check; at most two protocol/host attempts. */
  studioProbeTimeoutMs: z.number().int().positive().max(5_000).optional(),
  /** Read-only installed Agency catalog help; never launches a server. */
  catalogTimeoutMs: z.number().int().positive().max(5_000).optional(),
  /** Each native global setup/read-back command; no automatic mutation retries. */
  builtinSetupTimeoutMs: z.number().int().positive().max(5_000).optional(),
  /** Explicit native authentication continuation; the process and challenge expire together. */
  nativeAuthTimeoutMs: z.number().int().positive().max(180_000).optional(),
  nativeAuthMaxConcurrent: z.number().int().positive().max(2).optional(),
  optionsCacheTtlMs: z.number().int().min(1000).max(3_600_000).optional(),
  authObservationMaxEntries: z.number().int().positive().max(1000).optional(),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

export const mcpDefaults: McpConfig = {
  enabled: true,
  discoveryTimeoutMs: 15_000,
  maxConcurrentProbes: 2,
  studioProbeTimeoutMs: 3_000,
  catalogTimeoutMs: 3_000,
  builtinSetupTimeoutMs: 5_000,
  nativeAuthTimeoutMs: 120_000,
  nativeAuthMaxConcurrent: 1,
  optionsCacheTtlMs: 600_000,
  authObservationMaxEntries: 200,
};
