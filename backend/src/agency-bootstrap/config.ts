import { z } from 'zod';
import { executableSchema } from '../provider/command-options.js';

export const AGENCY_BOOTSTRAP_NAMESPACE = 'agencyBootstrap';
export const agencyBootstrapConfigSchema = z.object({
  windowsExecutable: executableSchema,
  posixExecutable: executableSchema,
  installTimeoutMs: z.number().int().min(1).max(900_000).default(180_000),
  versionTimeoutMs: z.number().int().min(1).max(60_000).default(15_000),
  microsoftNetworkHost: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/).max(253).default('redmond.corp.microsoft.com'),
  microsoftNetworkPort: z.number().int().min(1).max(65535).default(443),
  microsoftNetworkTimeoutMs: z.number().int().min(1).max(10_000).default(2000),
  microsoftNetworkRefreshMs: z.number().int().min(5000).max(300_000).default(30_000),
});
export type AgencyBootstrapConfig = z.input<typeof agencyBootstrapConfigSchema>;
export const agencyBootstrapDefaults: AgencyBootstrapConfig = {
  windowsExecutable: 'powershell',
  posixExecutable: 'sh',
  installTimeoutMs: 180_000,
  versionTimeoutMs: 15_000,
  microsoftNetworkHost: 'redmond.corp.microsoft.com',
  microsoftNetworkPort: 443,
  microsoftNetworkTimeoutMs: 2000,
  microsoftNetworkRefreshMs: 30_000,
};
