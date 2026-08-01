import type { ConfigObject } from './config-contract.js';

/** Placeholder substituted for any config value sourced from a secret. */
export const REDACTED = '••••••••';

const REFERENCE = /\$\{env:[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Walks a *raw* (pre-resolution) config object and returns the dotted paths of
 * every string value that contains a `${env:…}` secret reference. These paths
 * identify fields whose resolved value is a real secret and must not be exposed
 * over the API.
 */
export function collectSecretPaths(config: ConfigObject): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, trail: string): void => {
    if (typeof value === 'string') {
      if (REFERENCE.test(value)) {
        paths.push(trail);
      }
      return;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value as ConfigObject)) {
        walk(inner, trail ? `${trail}.${key}` : key);
      }
    }
  };
  walk(config, '');
  return paths;
}

/**
 * Returns a deep clone of {@link config} with every value at one of {@link paths}
 * replaced by {@link REDACTED}. Paths that do not resolve to a value are ignored.
 */
export function redactSecretPaths(
  config: ConfigObject,
  paths: readonly string[],
): ConfigObject {
  const clone = structuredClone(config) as ConfigObject;
  for (const path of paths) {
    const segments = path.split('.');
    const last = segments.pop() as string;
    let cursor: ConfigObject | undefined = clone;
    for (const segment of segments) {
      const next: unknown = cursor?.[segment];
      cursor =
        next !== null && typeof next === 'object' && !Array.isArray(next)
          ? (next as ConfigObject)
          : undefined;
    }
    if (cursor && Object.prototype.hasOwnProperty.call(cursor, last)) {
      cursor[last] = REDACTED;
    }
  }
  return clone;
}
