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
   * Delay (ms) between writing the instruction block and sending the submit
   * keystroke. The interactive CLI treats a fast multi-line write as a paste
   * and would absorb an immediately-trailing newline as a line break; sending
   * the submit keystroke on its own, once the paste burst settles, makes the
   * CLI submit the seeded message instead of leaving it in the composer.
   */
  instructionSeedSubmitDelayMs: z.number().int().nonnegative(),
});

export type TerminalConfig = z.infer<typeof terminalConfigSchema>;

export const terminalDefaults: TerminalConfig = {
  enabled: true,
  wsPath: '/api/terminal',
  defaultCols: 120,
  defaultRows: 30,
  scrollbackBytes: 262144,
  instructionSeedSuffix: '\r',
  instructionSeedReadyPattern: '\\?\\s*help|\\bcommands\\b',
  instructionSeedReadyTimeoutMs: 15000,
  instructionSeedSubmitDelayMs: 300,
};
