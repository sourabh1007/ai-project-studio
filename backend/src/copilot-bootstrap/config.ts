import { z } from 'zod';
import { executableSchema } from '../provider/command-options.js';

export const COPILOT_BOOTSTRAP_NAMESPACE = 'copilotBootstrap';
export const copilotBootstrapConfigSchema = z.object({
  windowsExecutable: executableSchema,
  posixExecutable: executableSchema,
  installTimeoutMs: z.number().int().min(1).max(900_000).default(180_000),
  versionTimeoutMs: z.number().int().min(1).max(60_000).default(15_000),
  /** Required native package postinstall; override inherited ignore-scripts only for this explicit install. */
  allowInstallScripts: z.boolean().default(true),
});
export type CopilotBootstrapConfig = z.input<typeof copilotBootstrapConfigSchema>;
export const copilotBootstrapDefaults: CopilotBootstrapConfig = {
  windowsExecutable: 'cmd',
  posixExecutable: 'sh',
  installTimeoutMs: 180_000,
  versionTimeoutMs: 15_000,
  allowInstallScripts: true,
};
