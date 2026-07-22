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
});

export type TerminalConfig = z.infer<typeof terminalConfigSchema>;

export const terminalDefaults: TerminalConfig = {
  enabled: true,
  wsPath: '/api/terminal',
  defaultCols: 120,
  defaultRows: 30,
  scrollbackBytes: 262144,
};
