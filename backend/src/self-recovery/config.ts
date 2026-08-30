import { z } from 'zod';

/**
 * Configuration for the self-recovery feature: the IDE's attempt to heal a live
 * session from a recoverable error (a corrupted CLI conversation surfacing as a
 * `400 Bad Request`, a slow MCP handshake, a transient upstream blip) without
 * the user having to notice or manually restart the session.
 */
export const SELF_RECOVERY_NAMESPACE = 'selfRecovery';

export const selfRecoveryConfigSchema = z.object({
  /** Master switch for automatic session self-recovery. */
  enabled: z.boolean(),
  /**
   * Whether, once in-session re-submits are exhausted, a metasession is used to
   * analyze the failure and surface a diagnosis before the last-resort restart.
   * When the metasession itself cannot spin up, the failure is reported to the
   * status bar instead of silently escalating.
   */
  useMetaAnalysis: z.boolean(),
});

export type SelfRecoveryConfig = z.infer<typeof selfRecoveryConfigSchema>;

export const selfRecoveryDefaults: SelfRecoveryConfig = {
  enabled: true,
  useMetaAnalysis: true,
};
