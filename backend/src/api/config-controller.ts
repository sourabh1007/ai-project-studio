import type { ConfigObject } from '../config/config-contract.js';
import type { ConfigSchemaRegistry } from '../config/config-schema-registry.js';
import { redactSecretPaths } from '../config/config-redactor.js';
import type { Route } from './http-contract.js';

export interface ConfigControllerDeps {
  registry: ConfigSchemaRegistry;
  /** The effective, merged configuration currently in use. */
  current: ConfigObject;
  /**
   * Dotted paths whose values were resolved from `${env:…}` secret references.
   * Their values are redacted before the config is returned so secrets never
   * leak over the unauthenticated localhost endpoint.
   */
  secretPaths: readonly string[];
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
          current: redactSecretPaths(deps.current, deps.secretPaths),
        },
      }),
    },
  ];
}
