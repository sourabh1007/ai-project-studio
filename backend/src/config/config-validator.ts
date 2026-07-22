import { ZodError } from 'zod';
import { ConfigError } from '../kernel/error-types.js';
import type {
  ConfigObject,
  ConfigSource,
  SecretLookup,
} from './config-contract.js';
import type { ConfigSchemaRegistry } from './config-schema-registry.js';
import { mergeSources } from './config-loader.js';
import { resolveSecrets } from './secret-resolver.js';

/** Validates a raw config object against the registry's combined schema. */
export function validateConfig(
  registry: ConfigSchemaRegistry,
  raw: ConfigObject,
): ConfigObject {
  try {
    return registry.combinedSchema().parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      const summary = error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new ConfigError(`Invalid configuration: ${summary}`, error.issues);
    }
    throw error;
  }
}

/**
 * Composition root for configuration. Layers registry defaults beneath the
 * supplied sources (workspace -> user -> env), resolves secret references, and
 * validates the result. Returns the fully typed, validated config object.
 */
export function buildConfig(params: {
  registry: ConfigSchemaRegistry;
  sources: ConfigSource[];
  secretLookup: SecretLookup;
}): ConfigObject {
  const { registry, sources, secretLookup } = params;
  const defaultsSource: ConfigSource = {
    origin: 'defaults',
    data: registry.defaults(),
  };
  const merged = mergeSources([defaultsSource, ...sources]);
  const resolved = resolveSecrets(merged, secretLookup);
  return validateConfig(registry, resolved);
}
