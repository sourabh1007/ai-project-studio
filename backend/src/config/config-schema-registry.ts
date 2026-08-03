import { z, type ZodType } from 'zod';
import { ConfigError } from '../kernel/error-types.js';
import type { ConfigModuleSchema, ConfigObject } from './config-contract.js';

/**
 * Central registry of per-module configuration schemas. Modules register their
 * namespace here; the registry produces the combined schema and default object
 * used by the loader/validator. This is what makes the app open/closed:
 * a new module contributes settings without any core change.
 */
export interface ConfigSchemaRegistry {
  register<T>(module: ConfigModuleSchema<T>): void;
  namespaces(): string[];
  combinedSchema(): ZodType<ConfigObject>;
  defaults(): ConfigObject;
  /** The zod schema for a single namespace, or undefined if unregistered. */
  schemaFor(namespace: string): ZodType | undefined;
  /** The compiled defaults for a single namespace, or undefined. */
  defaultsFor(namespace: string): unknown;
}

export function createConfigSchemaRegistry(): ConfigSchemaRegistry {
  const modules = new Map<string, ConfigModuleSchema>();

  return {
    register(module) {
      if (modules.has(module.namespace)) {
        throw new ConfigError(
          `Config namespace already registered: ${module.namespace}`,
        );
      }
      modules.set(module.namespace, module as ConfigModuleSchema);
    },

    namespaces() {
      return [...modules.keys()];
    },

    combinedSchema() {
      const shape: Record<string, ZodType> = {};
      for (const [namespace, module] of modules) {
        shape[namespace] = module.schema;
      }
      return z.object(shape).strict() as unknown as ZodType<ConfigObject>;
    },

    defaults() {
      const out: ConfigObject = {};
      for (const [namespace, module] of modules) {
        out[namespace] = module.defaults;
      }
      return out;
    },

    schemaFor(namespace) {
      return modules.get(namespace)?.schema;
    },

    defaultsFor(namespace) {
      return modules.get(namespace)?.defaults;
    },
  };
}
