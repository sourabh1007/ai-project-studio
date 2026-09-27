import { isDeepStrictEqual } from 'node:util';
import type { McpServerEntry } from './mcp-contract.js';

/** Coalesce declarations only for the same native built-in; never custom aliases. */
export function mergeBuiltinSources(entries: McpServerEntry[]): McpServerEntry[] {
  const globals = new Map(entries.filter((entry) => entry.origin === 'agency-built-in' && typeof entry.builtinName === 'string' &&
    entry.configurationSources?.[0].kind === 'global').map((entry) => [entry.builtinName, entry]));
  const globalEntries = new Set(globals.values());
  const paired = new Set<McpServerEntry>();
  const result = entries.filter((entry) => !globalEntries.has(entry)).map((entry) => {
    if (entry.origin !== 'agency-built-in' || entry.configurationSources?.[0].kind !== 'resolved') return entry;
    const global = globals.get(entry.builtinName);
    if (!global) return entry;
    paired.add(global);
    const same = isDeepStrictEqual(entry.spec, global.spec) && entry.enabled === global.enabled;
    const merged: McpServerEntry = {
      ...(same ? global : entry),
      configurationConflict: !same,
      configurationSources: [...entry.configurationSources, ...global.configurationSources!],
    };
    if (!same) merged.capabilities = {
      ...merged.capabilities!,
      edit: {
        supported: false,
        reason: 'Resolved Agency settings differ from the global declaration. The card shows resolved settings; inspect both sources before changing native configuration. Global editing is blocked to avoid changing the wrong source.',
      },
    };
    return merged;
  });
  for (const global of globals.values()) {
    if (paired.has(global)) continue;
    result.push({
      ...global,
      capabilities: {
        ...global.capabilities!,
        tools: {
          supported: false,
          reason: 'Native tool inspection requires a verified resolved declaration. This global declaration has not been confirmed in resolved Agency configuration.',
        },
        edit: {
          supported: false,
          reason: 'This global declaration has not been confirmed in resolved Agency configuration. Refresh or resolve the source discrepancy before editing it.',
        },
      },
    });
  }
  return result;
}
