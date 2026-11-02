import { z } from 'zod';

/** Configuration for the background provider-credential warm loop. */
export const AUTH_WARMER_NAMESPACE = 'authWarmer';

export const authWarmerConfigSchema = z.object({
  /** Whether the background credential warm loop runs at all. */
  enabled: z.boolean(),
  /**
   * Interval for silent GitHub/Azure DevOps credential refresh. This updates
   * future child environments, not already-running processes or unrelated
   * native MCP caches. Revocation and access policies can still require sign-in.
   */
  intervalMs: z.number().int().positive(),
  maxConcurrentReads: z.number().int().min(1).max(32).default(8),
});

export type AuthWarmerConfig = z.infer<typeof authWarmerConfigSchema>;

export const authWarmerDefaults: AuthWarmerConfig = {
  enabled: true,
  intervalMs: 600_000,
  maxConcurrentReads: 8,
};
