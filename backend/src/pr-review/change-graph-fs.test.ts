import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeChangeGraphFs } from './change-graph-fs.js';

describe('nodeChangeGraphFs', () => {
  it('reads a file and lists directory files (excluding subdirectories)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cg-fs-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'src', 'nested'), { recursive: true });
      await writeFile(join(root, 'src', 'App.csproj'), '<Project/>');
      await writeFile(join(root, 'src', 'Store.cs'), 'class Store {}');

      expect(await nodeChangeGraphFs.readFile(root, 'src/Store.cs')).toBe(
        'class Store {}',
      );
      const names = await nodeChangeGraphFs.listDir(root, 'src');
      expect(names.sort()).toEqual(['App.csproj', 'Store.cs']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists every descendant file recursively, or [] when unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cg-fs-'));
    try {
      await mkdir(join(root, 'src', 'nested'), { recursive: true });
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(root, 'src', 'Store.cs'), 'class Store {}');
      await writeFile(join(root, 'src', 'nested', 'Caller.cs'), 'class Caller {}');
      await writeFile(join(root, 'node_modules', 'pkg', 'Vendor.cs'), 'class V {}');

      // node_modules is a build/vendor dir and is skipped by the walk, so its
      // files never appear in the listing.
      const all = await nodeChangeGraphFs.listFilesRecursive(root, 'src');
      expect(all.sort()).toEqual(['src/Store.cs', 'src/nested/Caller.cs']);

      const fromRoot = await nodeChangeGraphFs.listFilesRecursive(root, '');
      expect(fromRoot.sort()).toEqual(['src/Store.cs', 'src/nested/Caller.cs']);

      expect(await nodeChangeGraphFs.listFilesRecursive(root, 'missing')).toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns null for an unreadable file and [] for a missing directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cg-fs-'));
    try {
      expect(await nodeChangeGraphFs.readFile(root, 'nope.cs')).toBeNull();
      expect(await nodeChangeGraphFs.listDir(root, 'missing')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
