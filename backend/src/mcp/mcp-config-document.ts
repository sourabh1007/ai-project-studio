import { ValidationError } from '../kernel/error-types.js';
import type { McpConfigDocument } from './mcp-contract.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Empty files are unconfigured; nonempty invalid content must never be discarded. */
export function parseMcpConfigDocument(raw: string, path: string): McpConfigDocument {
  const text = raw.replace(/^\uFEFF/u, '').trim();
  if (!text) return {};
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    // JSON parser messages can quote credentials from the source.
    throw new ValidationError(`MCP configuration "${path}" contains invalid JSON. Fix the file and retry; its contents have not been replaced.`);
  }
  if (!isObject(document) ||
      (document.mcpServers !== undefined && !isObject(document.mcpServers))) {
    throw new ValidationError(`MCP configuration "${path}" must be a JSON object with an object-valued mcpServers field when present. Fix the file and retry; its contents have not been replaced.`);
  }
  return document;
}
