import type { IdeUsageService } from '../ide-usage/ide-usage-service.js';
import type { Route } from './http-contract.js';

export interface IdeUsageControllerDeps {
  ideUsage: IdeUsageService;
}

/** Route exposing the IDE's own AI (meta-session) usage at the IDE level. */
export function createIdeUsageRoutes(deps: IdeUsageControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/usage/ide',
      handler: () => ({ status: 200, body: deps.ideUsage.read() }),
    },
  ];
}
