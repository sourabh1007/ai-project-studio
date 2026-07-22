import type { ZodType } from 'zod';

/**
 * Contract for the layered, IDE-grade configuration system.
 *
 * Each backend module registers its own namespaced schema + defaults with the
 * schema registry, so the core never hardcodes another module's settings.
 * Configuration is assembled from ordered sources (defaults -> workspace file ->
 * user file -> environment overrides), secret references are resolved, and the
 * merged result is validated against the combined schema.
 */

/** A plain, JSON-like configuration object. */
export type ConfigObject = Record<string, unknown>;

/** One layer of raw configuration. Later layers override earlier ones. */
export interface ConfigSource {
  /** Human-readable origin, used in error messages. */
  readonly origin: string;
  /** The raw (unvalidated) configuration data for this layer. */
  readonly data: ConfigObject;
}

/** A module's contribution to the global configuration schema. */
export interface ConfigModuleSchema<T = unknown> {
  /** Unique top-level namespace, e.g. "providers" or "credit". */
  readonly namespace: string;
  /** Zod schema validating this namespace's slice of config. */
  readonly schema: ZodType<T>;
  /** Default values used when no source provides them. */
  readonly defaults: T;
}

/** Resolves a secret reference name (e.g. an env var) to its value. */
export type SecretLookup = (name: string) => string | undefined;
