import type { McpConfigDocument } from './mcp-contract.js';
import { ValidationError } from '../kernel/error-types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Legacy declaration helper, not an effective-session inventory or a headless
 * safety check. Use headlessMcpServerNames for conservative suppression.
 */
export function enabledMcpServerNames(
  document: McpConfigDocument | null,
): string[] {
  const servers = document?.mcpServers;
  if (!isPlainObject(servers)) {
    return [];
  }

  return Object.entries(servers)
    .filter(
      ([, spec]) => isPlainObject(spec) && spec.enabled !== false,
    )
    .map(([name]) => name);
}

/** Do not execute untrusted workspace declarations to discover what they might load. */
export function headlessMcpServerNames(sources: ReadonlyArray<{
  label: string;
  document: unknown;
  allowBareMap?: boolean;
}>): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    if (source.document === null) continue;
    if (!isPlainObject(source.document)) throw new ValidationError(`Cannot safely suppress MCP from ${source.label}. Repair its configuration in the native CLI before running headless tasks.`);
    const map = source.allowBareMap && !Object.hasOwn(source.document, 'mcpServers')
      ? source.document : source.document.mcpServers;
    if (map === undefined) continue;
    if (!isPlainObject(map) || Object.entries(map).some(([name, spec]) => !name.trim() || name.startsWith('-') || !isPlainObject(spec))) {
      throw new ValidationError(`Cannot safely suppress MCP from ${source.label}. Repair its configuration in the native CLI before running headless tasks.`);
    }

    for (const name of Object.keys(map)) names.add(name);
  }
  return [...names];
}

/** Native list output includes effective user, workspace, plugin and built-in sources. */
export function nativeMcpServerNames(raw: string): string[] {
  let document: unknown;
  try { document = JSON.parse(raw); }
  catch { throw new ValidationError('The native CLI did not return valid MCP inventory JSON. Update the CLI and retry; no automated session was launched.'); }
  if (!isPlainObject(document) || !Object.hasOwn(document, 'mcpServers')) {
    throw new ValidationError('The native CLI MCP inventory format is unsupported. Update the CLI and retry; no automated session was launched.');
  }
  return headlessMcpServerNames([{ label: 'native CLI effective inventory', document }]);
}
