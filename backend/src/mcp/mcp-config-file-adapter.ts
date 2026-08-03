import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpConfigDocument, McpConfigFileStore } from './mcp-contract.js';

/**
 * Filesystem adapter for a provider's MCP config JSON file. Thin IO at the edge
 * (excluded from coverage like the other native/IO adapters): all merge/parse
 * logic lives in the pure service.
 */
export function createMcpConfigFileStore(): McpConfigFileStore {
  return {
    async read(path) {
      try {
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw) as McpConfigDocument;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    async write(path, document) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    },
  };
}
