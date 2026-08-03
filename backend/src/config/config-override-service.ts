import { ZodError, type ZodType } from 'zod';
import type { Clock } from '../kernel/clock.js';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { ConfigObject } from './config-contract.js';
import { deepMerge } from './config-loader.js';
import type { ConfigSchemaRegistry } from './config-schema-registry.js';
import type { ConfigOverrideStore } from './config-override-store.js';

export interface ConfigOverrideServiceDeps {
  store: ConfigOverrideStore;
  registry: ConfigSchemaRegistry;
  clock: Clock;
  /** Notified after any successful change so callers can log/refresh. */
  onChanged?: (namespace: string) => void;
}

/** The effective, validated value of one namespace after applying overrides. */
export interface NamespaceConfigResult {
  namespace: string;
  /** The validated, effective config (defaults deep-merged with the override). */
  effective: ConfigObject;
  /** The stored override patch (empty object when reset to defaults). */
  override: ConfigObject;
  /**
   * True when the change only takes effect after an app restart. Every module
   * reads its config once at startup, so any persisted change is restart-gated.
   */
  requiresRestart: boolean;
}

function isPlainObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Service for reading and mutating persisted, per-namespace configuration
 * overrides. Each update deep-merges the incoming patch onto the namespace's
 * existing override, validates the resulting effective config against the
 * module's schema, and persists the merged patch. Storing the patch (not the
 * fully-resolved object) keeps untouched settings tracking their defaults.
 */
export function createConfigOverrideService(deps: ConfigOverrideServiceDeps) {
  function schemaAndDefaults(namespace: string): {
    schema: ZodType;
    defaults: ConfigObject;
  } {
    const schema = deps.registry.schemaFor(namespace);
    if (!schema) {
      throw new NotFoundError(`Unknown config namespace: ${namespace}`);
    }
    const defaults = deps.registry.defaultsFor(namespace);
    if (!isPlainObject(defaults)) {
      throw new ValidationError(
        `Config namespace is not an object: ${namespace}`,
      );
    }
    return { schema, defaults };
  }

  function validate(
    namespace: string,
    schema: ZodType,
    effective: ConfigObject,
  ): ConfigObject {
    try {
      return schema.parse(effective) as ConfigObject;
    } catch (error) {
      if (error instanceof ZodError) {
        const summary = error.issues
          .map(
            (issue) =>
              `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('; ');
        throw new ValidationError(
          `Invalid ${namespace} configuration: ${summary}`,
          error.issues,
        );
      }
      throw error;
    }
  }

  return {
    /** The stored override patch for a namespace (empty object when none). */
    getOverride(namespace: string): ConfigObject {
      return deps.store.get(namespace)?.data ?? {};
    },

    /** Deep-merge a patch onto the namespace override, validate, and persist. */
    update(namespace: string, patch: ConfigObject): NamespaceConfigResult {
      if (!isPlainObject(patch)) {
        throw new ValidationError('Config patch must be an object');
      }
      const { schema, defaults } = schemaAndDefaults(namespace);
      const existing = deps.store.get(namespace)?.data ?? {};
      const mergedOverride = deepMerge(existing, patch);
      const effective = validate(
        namespace,
        schema,
        deepMerge(defaults, mergedOverride),
      );
      deps.store.set({
        namespace,
        data: mergedOverride,
        updatedAt: deps.clock.isoNow(),
      });
      deps.onChanged?.(namespace);
      return {
        namespace,
        effective,
        override: mergedOverride,
        requiresRestart: true,
      };
    },

    /** Drop all overrides for a namespace, returning the pure defaults. */
    reset(namespace: string): NamespaceConfigResult {
      const { schema, defaults } = schemaAndDefaults(namespace);
      const effective = validate(namespace, schema, defaults);
      deps.store.delete(namespace);
      deps.onChanged?.(namespace);
      return {
        namespace,
        effective,
        override: {},
        requiresRestart: true,
      };
    },
  };
}

export type ConfigOverrideService = ReturnType<
  typeof createConfigOverrideService
>;
