import type { ConfigObject } from '../config/config-contract.js';
import type { ConfigSchemaRegistry } from '../config/config-schema-registry.js';
import type { Route } from './http-contract.js';

export interface ConfigControllerDeps {
  registry: ConfigSchemaRegistry;
  /** The effective, merged configuration currently in use. */
  current: ConfigObject;
}

/**
 * Routes exposing the effective configuration and the registered namespaces so
 * the Settings UI can render editable, grouped controls without hardcoding.
 */
export function createConfigRoutes(deps: ConfigControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/config',
      handler: () => ({
        status: 200,
        body: {
          namespaces: deps.registry.namespaces(),
          defaults: deps.registry.defaults(),
          current: deps.current,
        },
      }),
    },
  ];
}
