import { createHash } from 'node:crypto';
import type { McpServerEntry, McpToolInspection } from './mcp-contract.js';
import { nativeAuthenticationRequired, nativeCredentialsExpired } from './native-mcp-auth.js';

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

/** Fingerprints are internal and never retain plaintext configuration as cache keys. */
export function mcpObservationKey(provider: string, canonical: string, launch: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([provider, canonical, normalized(launch)])).digest('hex');
}

export function observedMcpAuth(result: McpToolInspection, checkedAt: string): NonNullable<McpServerEntry['authState']> {
  if (result.status === 'ok') return {
    state: 'ready', checkedAt, message: 'Tool inventory succeeded at this time. Authorization for individual tools has not been verified.',
  };
  if (nativeCredentialsExpired(result.message, result.output)) return {
    state: 'expired', checkedAt, message: 'The native process explicitly reported expired credentials. No expiry time was inferred.',
  };
  if (nativeAuthenticationRequired(result.message, result.output)) return {
    state: 'required', checkedAt, message: 'The native process explicitly requested authentication.',
  };
  return { state: 'unknown', checkedAt, message: 'This check did not establish authentication state. A timeout or connection error is not proof of expired credentials.' };
}
