import { ConfigError } from '../kernel/error-types.js';
import type { ConfigObject, SecretLookup } from './config-contract.js';

/**
 * Resolves secret references embedded in configuration values so secrets are
 * never hardcoded. A reference has the form `${env:NAME}` and is replaced with
 * the value returned by the supplied lookup. Multiple references may appear in
 * one string. Unknown references raise a ConfigError.
 */

const REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function resolveString(value: string, lookup: SecretLookup): string {
  return value.replace(REFERENCE, (_match, name: string) => {
    const resolved = lookup(name);
    if (resolved === undefined) {
      throw new ConfigError(`Unresolved secret reference: env:${name}`);
    }
    return resolved;
  });
}

function resolveValue(value: unknown, lookup: SecretLookup): unknown {
  if (typeof value === 'string') {
    return resolveString(value, lookup);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, lookup));
  }
  if (value !== null && typeof value === 'object') {
    const out: ConfigObject = {};
    for (const [key, inner] of Object.entries(value as ConfigObject)) {
      out[key] = resolveValue(inner, lookup);
    }
    return out;
  }
  return value;
}

export function resolveSecrets(
  config: ConfigObject,
  lookup: SecretLookup,
): ConfigObject {
  return resolveValue(config, lookup) as ConfigObject;
}
