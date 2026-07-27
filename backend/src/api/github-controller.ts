import type { GithubAuthStatus } from '../github-auth/github-auth-service.js';
import type { Route } from './http-contract.js';

export interface GithubControllerDeps {
  githubStatus: () => Promise<GithubAuthStatus>;
}

/** Route exposing the IDE's current GitHub authentication status. */
export function createGithubRoutes(deps: GithubControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/github/status',
      handler: async () => ({ status: 200, body: await deps.githubStatus() }),
    },
  ];
}
