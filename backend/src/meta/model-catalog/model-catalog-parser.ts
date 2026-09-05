import type { MetaModelOption } from './model-catalog-contract.js';

/** Reads a string property, returning `null` when absent or not a string. */
function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Parses a CLI usage label such as `"15x"`, `"0.33x"` or `"1x"` into its
 * numeric multiplier. Returns `null` for anything that is not a bare number
 * followed by `x` (e.g. missing labels or the `auto` model).
 */
export function parseUsageMultiplier(label: string | null): number | null {
  if (label === null) {
    return null;
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)x$/.exec(label.trim());
  return match ? Number(match[1]) : null;
}

function toOption(entry: unknown): MetaModelOption | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = str(record, 'modelId');
  if (id === null || id.length === 0) {
    return null;
  }
  const meta =
    typeof record._meta === 'object' && record._meta !== null
      ? (record._meta as Record<string, unknown>)
      : {};
  const usageLabel = str(meta, 'copilotUsage');
  return {
    id,
    name: str(record, 'name') ?? id,
    description: str(record, 'description') ?? '',
    usageLabel,
    usageMultiplier: parseUsageMultiplier(usageLabel),
    priceCategory: str(meta, 'copilotPriceCategory'),
    enabled: str(meta, 'copilotEnablement') !== 'disabled',
  };
}

/**
 * Extracts the selectable model catalog from an ACP `session/new` result. The
 * relevant shape is `result.models.availableModels: [{ modelId, name,
 * description, _meta: { copilotUsage, copilotPriceCategory, copilotEnablement }
 * }]`. Entries without a usable `modelId` are dropped; a missing or malformed
 * catalog yields an empty array.
 */
export function parseAvailableModels(
  result: Record<string, unknown> | null,
): MetaModelOption[] {
  const models =
    result && typeof result.models === 'object' && result.models !== null
      ? (result.models as Record<string, unknown>)
      : null;
  const list = models?.availableModels;
  if (!Array.isArray(list)) {
    return [];
  }
  const out: MetaModelOption[] = [];
  for (const entry of list) {
    const option = toOption(entry);
    if (option !== null) {
      out.push(option);
    }
  }
  return out;
}
