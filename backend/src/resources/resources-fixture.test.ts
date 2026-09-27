import { resolve } from 'node:path';
import { it, expect, vi } from 'vitest';
import type { FileInfo, ResourceFileSystem } from './resources-contract.js';

export const root = resolve('resource-test-fixture');
export const at = (...parts: string[]): string => resolve(root, ...parts);
export function fixtureFs() {
  const nodes = new Map<string, FileInfo>();
  const add = (path: string, kind: FileInfo['kind'] = 'file', size = 10, identity = `1:${path}`) => {
    nodes.set(path, { kind, size, identity, modifiedAt: 1, linkCount: 1 });
    return path;
  };
  const fs: ResourceFileSystem = {
    realPath: vi.fn(async (path) => path),
    stat: vi.fn(async (path) => {
      const result = nodes.get(path);
      if (!result) throw new Error(`Missing ${path}`);
      return result;
    }),
    entries: vi.fn(async function* (path) {
      for (const child of nodes.keys()) {
        if (child !== path && resolve(child, '..') === path) yield child.slice(path.length + 1);
      }
    }),
    unlink: vi.fn(async (path) => { nodes.delete(path); }),
    volume: vi.fn(async () => ({ totalBytes: 1000, freeBytes: 500, availableBytes: 400 })),
  };
  return { fs, nodes, add };
}
it('provides an entirely in-memory filesystem; never cleans user data', () => {
  expect(fixtureFs().nodes.size).toBe(0);
});
