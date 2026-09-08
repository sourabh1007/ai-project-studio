import { z } from 'zod';

/** Configuration schema for the interactive terminal module. */
export const TERMINAL_NAMESPACE = 'terminal';

export const terminalConfigSchema = z.object({
  /** Whether interactive PTY sessions are enabled. */
  enabled: z.boolean(),
  /** WebSocket path the renderer connects to for a live terminal. */
  wsPath: z.string().min(1),
  /** Default terminal width (columns) before the client reports its size. */
  defaultCols: z.number().int().positive(),
  /** Default terminal height (rows) before the client reports its size. */
  defaultRows: z.number().int().positive(),
  /** Max bytes of terminal output retained for replay to late-joining clients. */
  scrollbackBytes: z.number().int().positive(),
  /**
   * UTF-8 input limit advertised by protocol v2: maximum queued startup input,
   * individual input frame, and browser-side unacknowledged input bytes.
   */
  bootstrapInputBufferBytes: z.number().int().positive(),
  /**
   * Max bytes of the ANSI-stripped transcript retained per session for
   * persistence / summarization. Bounds heap growth for long-lived interactive
   * sessions; the oldest text is dropped once exceeded.
   */
  transcriptBytes: z.number().int().positive(),
  /** Keystroke appended after seeded skill instructions to submit them. */
  instructionSeedSuffix: z.string(),
  /**
   * Regex (source) matched against the interactive CLI's output to detect that
   * its input prompt is ready before seeding skill instructions. Seeding before
   * the TUI is interactive causes the submit keystroke to be swallowed during
   * boot, leaving the instructions unsent in the composer.
   */
  instructionSeedReadyPattern: z.string().min(1),
  /**
   * Fallback (ms) after which skill instructions are seeded even if the ready
   * pattern was never observed, so a prompt-detection miss never drops them.
   */
  instructionSeedReadyTimeoutMs: z.number().int().nonnegative(),
  /**
   * Quiet period (ms) of no terminal output that must elapse after writing the
   * instruction block before the submit keystroke is sent. The interactive CLI
   * treats a fast multi-line write as a paste and would absorb an
   * immediately-trailing newline as a line break; waiting for the paste echo
   * (and any in-flight agent response) to settle before submitting makes the
   * CLI submit the seeded message instead of leaving it in the composer.
   */
  instructionSeedSubmitDelayMs: z.number().int().nonnegative(),
  /**
   * Upper bound (ms) on how long to wait for the terminal to fall quiet before
   * submitting the seeded instructions anyway. Guarantees the message is sent
   * even if the CLI never stops emitting output (e.g. an animated spinner).
   */
  instructionSeedSubmitMaxWaitMs: z.number().int().nonnegative(),
  /**
   * Whether an interactive session may automatically re-submit a
   * provider-confirmed replay-safe request when the CLI reports a recoverable
   * provider/session failure. Browser/PTy keystrokes never establish replay
   * authority, so when no provider confirmation exists the session shows manual
   * retry guidance instead of replaying guessed input.
   */
  autoRetryEnabled: z.boolean(),
  /**
   * Extra automatic re-submits per recoverable-error streak, but only for an
   * exact request text the provider independently confirmed as replay-safe.
   */
  autoRetryMaxAttempts: z.number().int().nonnegative(),
  /**
   * Delay (ms) before an automatic re-submit of a provider-confirmed replay-safe
   * request, letting the upstream recover first.
   */
  autoRetryBackoffMs: z.number().int().nonnegative(),
});

export type TerminalConfig = z.infer<typeof terminalConfigSchema>;

export const terminalDefaults: TerminalConfig = {
  enabled: true,
  wsPath: '/api/terminal',
  defaultCols: 120,
  defaultRows: 30,
  scrollbackBytes: 262144,
  bootstrapInputBufferBytes: 65536,
  transcriptBytes: 1048576,
  instructionSeedSuffix: '\r',
  instructionSeedReadyPattern: '\\?\\s*help|\\bcommands\\b',
  instructionSeedReadyTimeoutMs: 15000,
  instructionSeedSubmitDelayMs: 500,
  instructionSeedSubmitMaxWaitMs: 10000,
  autoRetryEnabled: false,
  autoRetryMaxAttempts: 2,
  autoRetryBackoffMs: 2500,
};
