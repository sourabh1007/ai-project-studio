import { z } from 'zod';
import { executableSchema } from '../provider/command-options.js';

export const AGENCY_BOOTSTRAP_NAMESPACE = 'agencyBootstrap';
export const agencyBootstrapConfigSchema = z.object({
  windowsExecutable: executableSchema,
  posixExecutable: executableSchema,
  installTimeoutMs: z.number().int().min(1).max(900_000).default(180_000),
  versionTimeoutMs: z.number().int().min(1).max(60_000).default(15_000),
});
export type AgencyBootstrapConfig = z.input<typeof agencyBootstrapConfigSchema>;
export const agencyBootstrapDefaults: AgencyBootstrapConfig = {
  windowsExecutable: 'powershell',
  posixExecutable: 'sh',
  installTimeoutMs: 180_000,
  versionTimeoutMs: 15_000,
};
