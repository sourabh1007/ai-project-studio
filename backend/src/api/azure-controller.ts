import type { Route } from './http-contract.js';
import type {
  AzureDevOpsStatus,
  AzureTarget,
} from '../azure-auth/azure-devops-auth.js';
import { parseAzureTarget } from '../azure-auth/azure-devops-auth.js';

export interface AzureControllerDeps {
  /** Reports whether GCM already has a cached credential for the target. */
  azureStatus: (target: AzureTarget) => Promise<AzureDevOpsStatus>;
  /** Triggers an interactive Azure DevOps sign-in and caches the credential. */
  azureSignIn: (target: AzureTarget) => Promise<AzureDevOpsStatus>;
  /** Erases GCM's cached Azure DevOps credential for the target. */
  azureSignOut: (target: AzureTarget) => Promise<AzureDevOpsStatus>;
}

/**
 * Routes for IDE-level Azure DevOps authentication. `status` reports the cached
 * credential state; `signin` triggers the interactive WAM/browser sign-in that
 * primes the cache so every session then authenticates silently. Both accept an
 * optional organization / remote URL so the credential is scoped correctly.
 */
export function createAzureRoutes(deps: AzureControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/azure-devops/status',
      handler: async (req) => {
        const url = typeof req.query.url === 'string' ? req.query.url : null;
        return {
          status: 200,
          body: await deps.azureStatus(parseAzureTarget(url)),
        };
      },
    },
    {
      method: 'post',
      path: '/azure-devops/signin',
      handler: async (req) => {
        const body = (req.body ?? {}) as { url?: unknown };
        const url = typeof body.url === 'string' ? body.url : null;
        return {
          status: 200,
          body: await deps.azureSignIn(parseAzureTarget(url)),
        };
      },
    },
    {
      method: 'post',
      path: '/azure-devops/signout',
      handler: async (req) => {
        const body = (req.body ?? {}) as { url?: unknown };
        const url = typeof body.url === 'string' ? body.url : null;
        return {
          status: 200,
          body: await deps.azureSignOut(parseAzureTarget(url)),
        };
      },
    },
  ];
}
