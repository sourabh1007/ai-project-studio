import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const faults = vi.hoisted(() => ({ rename: false, write: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) throw new Error('replacement denied');
      return actual.rename(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (faults.write && String(args[0]).endsWith('.tmp')) {
        await actual.writeFile(args[0], 'partial');
        throw new Error('disk full');
      }
      return actual.writeFile(...args);
    },
  };
});
import { createMcpConfigFileStore } from './mcp-config-file-adapter.js';

const directories: string[] = [];
afterEach(async () => {
  faults.rename = false; faults.write = false;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-config-test-'));
  directories.push(directory);
  return { directory, path: join(directory, 'mcp-config.json'), store: createMcpConfigFileStore() };
}
describe('MCP configuration filesystem', () => {
  it('distinguishes missing, empty and malformed files without changing them during reads', async () => {
    const f = await fixture();
    expect(await f.store.read(f.path)).toBeNull();
    await writeFile(f.path, '');
    expect(await f.store.read(f.path)).toEqual({});
    expect(await readFile(f.path, 'utf8')).toBe('');
    await writeFile(f.path, '{"incomplete":');
    await expect(f.store.read(f.path)).rejects.toThrow('invalid JSON');
    expect(await readFile(f.path, 'utf8')).toBe('{"incomplete":');
  });
  it('atomically creates and replaces a complete configuration without leaving temporary files', async () => {
    const f = await fixture();
    const document = { otherSetting: true, mcpServers: { sample: { command: 'server' } } };
    await f.store.write(f.path, {});
    await f.store.write(f.path, document);
    expect(await f.store.read(f.path)).toEqual(document);
    expect(await readdir(f.directory)).toEqual(['mcp-config.json']);
  });
  it.each(['write', 'rename'] as const)('preserves the previous file after a failed %s', async (failure) => {
    const f = await fixture();
    const before = '{"mcpServers":{"existing":{"command":"keep"}}}';
    await writeFile(f.path, before);
    faults[failure] = true;
    await expect(f.store.write(f.path, { mcpServers: { replacement: {} } })).rejects.toThrow();
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(await readdir(f.directory)).toEqual(['mcp-config.json']);
  });
});
