import { z } from 'zod';

/** Configuration for the background provider-credential warm loop. */
export const AUTH_WARMER_NAMESPACE = 'authWarmer';

export const authWarmerConfigSchema = z.object({
  /** Whether the background credential warm loop runs at all. */
  enabled: z.boolean(),
  /**
   * How often (ms) to trigger a silent provider token refresh. Kept well under
   * the shortest provider access-token lifetime (Azure DevOps OAuth tokens last
   * ~1 hour) so a fresh access token is always cached before the current one
   * expires. Each refresh also exercises the underlying OAuth refresh token,
   * keeping its sliding expiry window alive so a long-idle account never lapses
   * into an interactive (browser) re-authentication mid-session.
   */
  intervalMs: z.number().int().positive(),
});

export type AuthWarmerConfig = z.infer<typeof authWarmerConfigSchema>;

export const authWarmerDefaults: AuthWarmerConfig = {
  enabled: true,
  intervalMs: 600_000,
};
