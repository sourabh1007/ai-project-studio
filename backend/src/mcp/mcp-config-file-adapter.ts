import { mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpConfigFileStore } from './mcp-contract.js';
import { parseMcpConfigDocument } from './mcp-config-document.js';

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
        return parseMcpConfigDocument(raw, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },
    async write(path, document) {
      let destination = path;
      try {
        destination = await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
          encoding: 'utf8', flag: 'wx', mode: 0o600,
        });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
