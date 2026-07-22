import { describe, it, expect } from 'vitest';
import { z, type ZodType } from 'zod';
import { validateConfig, buildConfig } from './config-validator.js';
import { createConfigSchemaRegistry } from './config-schema-registry.js';
import type { ConfigSchemaRegistry } from './config-schema-registry.js';
import type { ConfigObject } from './config-contract.js';
import { ConfigError } from '../kernel/error-types.js';

function registryWith(): ConfigSchemaRegistry {
  const reg = createConfigSchemaRegistry();
  reg.register({
    namespace: 'app',
    schema: z.object({ name: z.string(), retries: z.coerce.number() }),
    defaults: { name: 'default', retries: 1 },
  });
  return reg;
}

describe('config-validator', () => {
  describe('validateConfig', () => {
    it('returns typed config on success', () => {
      const reg = registryWith();
      const out = validateConfig(reg, { app: { name: 'x', retries: 3 } });
      expect(out).toEqual({ app: { name: 'x', retries: 3 } });
    });

    it('throws ConfigError with a readable summary on invalid input', () => {
      const reg = registryWith();
      expect(() => validateConfig(reg, { app: { retries: 'nope' } })).toThrow(
        ConfigError,
      );
    });

    it('labels root-level issues as <root>', () => {
      const reg = registryWith();
      expect(() => validateConfig(reg, null as unknown as ConfigObject)).toThrow(
        /<root>/,
      );
    });

    it('rethrows non-Zod errors from the schema', () => {
      const boom = new Error('boom');
      const fakeRegistry = {
        combinedSchema: () =>
          ({
            parse: () => {
              throw boom;
            },
          }) as unknown as ZodType<ConfigObject>,
      } as unknown as ConfigSchemaRegistry;
      expect(() => validateConfig(fakeRegistry, {})).toThrow(boom);
    });
  });

  describe('buildConfig', () => {
    it('layers defaults, sources, secrets and validates', () => {
      const reg = registryWith();
      const config = buildConfig({
        registry: reg,
        sources: [
          { origin: 'workspace', data: { app: { name: '${env:NAME}' } } },
          { origin: 'env', data: { app: { retries: '5' } } },
        ],
        secretLookup: (n) => (n === 'NAME' ? 'resolved' : undefined),
      });
      expect(config).toEqual({ app: { name: 'resolved', retries: 5 } });
    });

    it('uses registry defaults when no sources override', () => {
      const reg = registryWith();
      const config = buildConfig({
        registry: reg,
        sources: [],
        secretLookup: () => undefined,
      });
      expect(config).toEqual({ app: { name: 'default', retries: 1 } });
    });
  });
});
