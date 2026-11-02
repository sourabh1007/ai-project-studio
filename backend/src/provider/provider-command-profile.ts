import { z } from 'zod';
import { interactiveCommandSchema, versionCommandArgsSchema } from './command-options.js';

export const providerCommandProfileSchema = z.object({
  usageCommand: interactiveCommandSchema,
  versionArgs: versionCommandArgsSchema,
  /** Display-only native login hint; never executed by the application. */
  loginCommand: interactiveCommandSchema.nullable(),
  liveReloadCommand: interactiveCommandSchema.optional().describe('Legacy session-manager reload hint only. The category MCP manager does not send this command to running sessions; use the native CLI to reconnect or start a new session.'),
});

export const copilotCommandProfile = {
  usageCommand: '/usage',
  versionArgs: ['--version'],
  loginCommand: '/login',
  liveReloadCommand: '/restart',
};
