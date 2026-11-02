import { commandCatalog, type CommandCatalogEntry } from '../tools/command-catalog.js';
import type { Route } from './http-contract.js';

export function createCommandCatalogRoutes(deps: {
  entries: readonly CommandCatalogEntry[];
  exposed: (namespace: string) => boolean;
}): Route[] {
  return [{
    method: 'get', path: '/tools/commands',
    handler: () => ({ status: 200, body: commandCatalog(deps.entries, deps.exposed) }),
  }];
}
