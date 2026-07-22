import type { UsageAttributeKeys } from './config.js';

/**
 * Determines the model actually used for an inference call, preferring the
 * resolved response model over the requested one (which may be 'auto').
 */
export function extractResolvedModel(
  attributes: Record<string, unknown>,
  keys: UsageAttributeKeys,
): string {
  const value = attributes[keys.responseModel] ?? attributes[keys.requestModel];
  return value === undefined || value === null ? 'unknown' : String(value);
}
