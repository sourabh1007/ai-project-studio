import { z } from 'zod';

/**
 * Configuration for the shared meta-session runner: the reusable "invoke the
 * CLI headlessly as AI" mechanism factored out so every AI feature (summaries,
 * task plans, …) drives it the same, config-driven way.
 */
export const META_NAMESPACE = 'meta';

export const metaConfigSchema = z.object({
  /** Provider used to run meta AI sessions. */
  providerId: z.string().min(1),
  /** Model used for meta sessions (may be 'auto'). */
  model: z.string().min(1),
  /** Candidate JSON keys to read the assistant's text from CLI JSON output. */
  responseTextKeys: z.array(z.string().min(1)).min(1),
  /**
   * Hard ceiling (ms) for a single metasession. If the provider CLI has not
   * finished within this window it is killed and the run fails, so a stalled
   * session never hangs the caller (e.g. a PR review step) indefinitely.
   */
  timeoutMs: z.number().int().positive(),
  /**
   * Warm ACP session pool. When enabled, PR review turns lease a live
   * `copilot --acp` session from a small pool instead of cold-spawning a CLI
   * process per request, so the heavy startup (MCP proxies + auth) is paid once.
   */
  warmPool: z.object({
    /** Whether the warm pool is used (cold path remains the fallback). */
    enabled: z.boolean(),
    /** Number of warm sessions to keep ready. */
    size: z.number().int().positive(),
    /** Absolute path to the copilot executable driving the ACP process. */
    executable: z.string().min(1),
    /** Timeout (ms) for the one-time ACP `initialize` handshake. */
    initializeTimeoutMs: z.number().int().positive(),
    /** Timeout (ms) for a single warm turn (session/new + session/prompt). */
    turnTimeoutMs: z.number().int().positive(),
  }),
});

export type MetaConfig = z.infer<typeof metaConfigSchema>;

export const metaDefaults: MetaConfig = {
  // Keep in sync with the enabled provider(s) in the provider config
  // (Agency by default), mirroring the summarizer defaults.
  providerId: 'agency',
  model: 'auto',
  responseTextKeys: ['response', 'text', 'content', 'message', 'result'],
  // 5 minutes: generous for a real AI turn, but bounded so a wedged CLI
  // surfaces as a failed step instead of an eternal "Analyzing…" spinner.
  timeoutMs: 300_000,
  warmPool: {
    // Off by default: opt-in until proven on the heavy PR path.
    enabled: false,
    size: 2,
    // Resolved to the real copilot executable at startup in main.ts.
    executable: 'copilot',
    initializeTimeoutMs: 120_000,
    turnTimeoutMs: 300_000,
  },
};
