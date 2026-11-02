import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createEarlyConfigFileStore } from './early-config-file-adapter.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(), readFileSync: vi.fn(), renameSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn(),
}));

describe('shared early module file adapter', () => {
  const file = join('settings', 'config-overrides', 'git.json');
  const record = { namespace: 'git', data: { executable: 'C:\\my git\\git.exe' }, updatedAt: 'now' };
  beforeEach(() => vi.resetAllMocks());

  it('reads the same module record used by the desktop and atomically replaces it on repeated saves', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(record));
    const store = createEarlyConfigFileStore('git', file);
    expect(store.get('git')).toEqual(record);
    expect(store.all()).toEqual([record]);
    store.set(record);
    store.set({ ...record, data: { executable: 'other' } });
    expect(mkdirSync).toHaveBeenCalledWith(join('settings', 'config-overrides'), { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(`${file}.next`, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    expect(renameSync).toHaveBeenCalledTimes(2);
    expect(renameSync).toHaveBeenCalledWith(`${file}.next`, file);
    store.delete('git');
    expect(rmSync).toHaveBeenCalledWith(file, { force: true });
  });

  it('treats absence as no override and fails clearly on invalid or unreadable records', () => {
    const store = createEarlyConfigFileStore('git', file);
    vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error(), { code: 'ENOENT' }); });
    expect(store.get('git')).toBeNull();
    expect(store.all()).toEqual([]);
    for (const value of ['invalid', '{}', JSON.stringify({ ...record, namespace: 'other' }), JSON.stringify({ ...record, data: [] })]) {
      vi.mocked(readFileSync).mockReturnValue(value);
      expect(() => store.get('git')).toThrow('Could not read git executable settings');
    }
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('denied'); });
    expect(() => store.get('git')).toThrow('Could not read git executable settings');
  });
});
