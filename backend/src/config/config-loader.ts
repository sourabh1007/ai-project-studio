import type { ConfigObject, ConfigSource } from './config-contract.js';

/** True for plain objects (not arrays, not null). */
function isPlainObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merges two config objects. Plain objects merge recursively; every other
 * value type (including arrays) is replaced wholesale by the override.
 */
export function deepMerge(base: ConfigObject, override: ConfigObject): ConfigObject {
  const out: ConfigObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Merges ordered config sources; later sources win (last-wins). */
export function mergeSources(sources: ConfigSource[]): ConfigObject {
  return sources.reduce<ConfigObject>(
    (acc, source) => deepMerge(acc, source.data),
    {},
  );
}

/**
 * Coerces a raw environment string into a typed scalar so env overrides work
 * with typed schemas (numbers, booleans, null, arrays/objects). Values that are
 * not valid JSON (plain identifiers, secret references) are kept as strings.
 */
export function coerceEnvValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Builds a config source from environment-style variables. Variables named
 * `<PREFIX>__a__b=value` expand into nested `{ a: { b: value } }`. This lets any
 * setting be overridden from the environment, like a real IDE.
 */
export function envSource(
  env: Record<string, string | undefined>,
  prefix: string,
  origin = 'env',
): ConfigSource {
  const data: ConfigObject = {};
  const marker = `${prefix}__`;
  for (const [rawKey, rawValue] of Object.entries(env)) {
    if (rawValue === undefined || !rawKey.startsWith(marker)) {
      continue;
    }
    const path = rawKey.slice(marker.length).split('__').filter(Boolean);
    if (path.length === 0) {
      continue;
    }
    let cursor = data;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i];
      if (!isPlainObject(cursor[segment])) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as ConfigObject;
    }
    cursor[path[path.length - 1]] = coerceEnvValue(rawValue);
  }
  return { origin, data };
}
