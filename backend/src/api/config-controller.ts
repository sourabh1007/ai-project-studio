import { z } from 'zod';
import type { ConfigObject } from '../config/config-contract.js';
import type { ConfigSchemaRegistry } from '../config/config-schema-registry.js';
import type { ConfigOverrideService } from '../config/config-override-service.js';
import { redactSecretPaths } from '../config/config-redactor.js';
import { describeNamespaces } from '../config/config-schema-describe.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

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
  /** Persisted, per-namespace override editing. */
  overrides: ConfigOverrideService;
}

const patchSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

/**
 * Routes exposing the effective configuration and the registered namespaces so
 * the Settings UI can render editable, grouped controls without hardcoding.
 * `PUT`/`DELETE` persist per-namespace overrides that apply on the next launch.
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
          // Per-setting schema metadata (type, bounds, enum options, nested
          // shape, description) so the UI can render typed, validated controls
          // for every registered setting without hardcoding any of them.
          schema: describeNamespaces(deps.registry),
          current: redactSecretPaths(deps.current, deps.secretPaths),
          overrides: Object.fromEntries(
            deps.registry
              .namespaces()
              .map((ns) => [ns, deps.overrides.getOverride(ns)]),
          ),
        },
      }),
    },
    {
      method: 'put',
      path: '/config/:namespace',
      handler: (req) => {
        const input = parseInput(patchSchema, req.body);
        const result = deps.overrides.update(
          req.params.namespace,
          input.values as ConfigObject,
        );
        return { status: 200, body: result };
      },
    },
    {
      method: 'delete',
      path: '/config/:namespace',
      handler: (req) => ({
        status: 200,
        body: deps.overrides.reset(req.params.namespace),
      }),
    },
  ];
}
