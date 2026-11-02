import { describe, expect, it, vi } from 'vitest';
import { createEarlyConfigOverrides, legacyExecutableSource } from './early-config-overrides.js';
import type { ConfigOverrideRecord, ConfigOverrideStore } from './config-override-store.js';
import { gitConfigSchema, gitDefaults } from '../git/config.js';
import { githubCliConfigSchema, githubCliDefaults } from '../github-auth/config.js';
import { desktopRuntimeConfigSchema, desktopRuntimeDefaults } from '../desktop-runtime/config.js';

function store(rows: ConfigOverrideRecord[] = []): ConfigOverrideStore {
  const map = new Map(rows.map((row) => [row.namespace, row]));
  return {
    all: () => [...map.values()],
    get: (namespace) => map.get(namespace) ?? null,
    set: vi.fn((record) => { map.set(record.namespace, record); }),
    delete: vi.fn((namespace) => { map.delete(namespace); }),
  };
}
const record = (namespace: string): ConfigOverrideRecord => ({ namespace, data: { executable: 'custom' }, updatedAt: 'now' });

describe('early module overrides', () => {
  it('uses exactly one owner for every read/write/reset, ignoring stale SQLite copies', () => {
    const fallback = store([record('git'), record('other')]);
    const git = store([record('git')]);
    const combined = createEarlyConfigOverrides(fallback, new Map([['git', git]]));
    expect(combined.all().map((row) => row.namespace)).toEqual(['other', 'git']);
    expect(combined.get('git')).toEqual(record('git'));
    expect(combined.get('other')).toEqual(record('other'));
    combined.set(record('git'));
    combined.set(record('other'));
    expect(git.set).toHaveBeenCalledWith(record('git'));
    expect(fallback.set).toHaveBeenCalledWith(record('other'));
    combined.delete('git');
    combined.delete('other');
    expect(git.delete).toHaveBeenCalledWith('git');
    expect(combined.all()).toEqual([]);
    expect(combined.get('git')).toBeNull();
  });

  it('preserves legacy executable environment overrides without mistaking managed Node for user configuration', () => {
    expect(legacyExecutableSource({}).data).toEqual({});
    expect(legacyExecutableSource({ CW_GIT_BIN: 'g', CW_GH_BIN: 'h', CW_NODE_BIN: 'n' }).data).toEqual({
      git: { executable: 'g' }, githubCli: { executable: 'h' }, desktopRuntime: { nodeExecutable: 'n' },
    });
    expect(legacyExecutableSource({ CW_NODE_BIN: 'managed', CW_NODE_BIN_OVERRIDE: '' }).data).toEqual({});
    expect(legacyExecutableSource({ CW_NODE_BIN: 'managed', CW_NODE_BIN_OVERRIDE: 'selected' }).data).toEqual({ desktopRuntime: { nodeExecutable: 'selected' } });
  });

  it('validates module-owned paths and defaults without allowing control characters', () => {
    expect(gitConfigSchema.parse(gitDefaults)).toEqual({ executable: 'git' });
    expect(githubCliConfigSchema.parse(githubCliDefaults)).toEqual({ executable: 'gh' });
    expect(desktopRuntimeConfigSchema.parse(desktopRuntimeDefaults)).toEqual({ nodeExecutable: '' });
    for (const executable of ['', 'bad\npath', 'bad\0path']) {
      expect(gitConfigSchema.safeParse({ executable }).success).toBe(false);
      expect(githubCliConfigSchema.safeParse({ executable }).success).toBe(false);
    }
    expect(desktopRuntimeConfigSchema.safeParse({ nodeExecutable: '\r' }).success).toBe(false);
  });
});
