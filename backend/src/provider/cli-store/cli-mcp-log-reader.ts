import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpLogReader } from '../../mcp-usage/mcp-log-capture.js';

/** Read-only, byte-bounded access to the public CLI session event log. */
export function createCliMcpLogReader(root: string): McpLogReader {
  return {
    async read(sessionId, cursor, maxBytes) {
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || sessionId.length > 128
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576
        || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
        throw new Error('Invalid MCP log read bounds or session identity');
      }
      const file = await open(join(root, sessionId, 'events.jsonl'), 'r');
      try {
        const stat = await file.stat();
        const reset = cursor.offset > stat.size;
        const offset = reset ? 0 : cursor.offset;
        const skipping = !reset && cursor.skipping;
        const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        const bytes = buffer.subarray(0, bytesRead);
        const last = bytes.lastIndexOf(10);
        if (last === -1) {
          const oversized = bytesRead === maxBytes;
          return {
            lines: [],
            cursor: oversized ? { offset: offset + bytesRead, skipping: true } : { offset, skipping },
            oversized,
          };
        }
        const first = skipping ? bytes.indexOf(10) + 1 : 0;
        const text = bytes.subarray(first, last + 1).toString('utf8');
        return {
          lines: text.split('\n').filter((line) => line.trim().length > 0),
          cursor: { offset: offset + last + 1, skipping: false },
          oversized: false,
        };
      } finally {
        await file.close();
      }
    },
  };
}
