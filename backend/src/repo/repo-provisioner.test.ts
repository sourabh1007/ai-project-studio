import { describe, it, expect } from 'vitest';
import { provisionRepo } from './repo-provisioner.js';

const base = {
  provider: 'github' as const,
  remoteUrl: 'https://github.com/acme/app.git',
  name: 'acme/app',
  defaultBranch: 'main',
};

describe('provisionRepo', () => {
  it('clones into an empty target path and returns the create input', async () => {
    const clones: unknown[] = [];
    const result = await provisionRepo(
      {
        pathExists: () => false,
        clone: async (req) => {
          clones.push(req);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
      { ...base, mode: 'clone', localPath: '  C:/work/app  ' },
    );
    expect(clones).toEqual([
      { remoteUrl: 'https://github.com/acme/app.git', targetPath: 'C:/work/app' },
    ]);
    expect(result).toEqual({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:/work/app',
      defaultBranch: 'main',
    });
  });

  it('rejects a clone into a path that already exists', async () => {
    await expect(
      provisionRepo(
        { pathExists: () => true, clone: async () => ({ code: 0, stdout: '', stderr: '' }) },
        { ...base, mode: 'clone', localPath: 'C:/work/app' },
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('surfaces a git clone failure as a validation error', async () => {
    await expect(
      provisionRepo(
        {
          pathExists: () => false,
          clone: async () => ({ code: 128, stdout: '', stderr: 'auth failed' }),
        },
        { ...base, mode: 'clone', localPath: 'C:/work/app' },
      ),
    ).rejects.toThrow('auth failed');
  });

  it('uses a default message when clone fails without stderr', async () => {
    await expect(
      provisionRepo(
        {
          pathExists: () => false,
          clone: async () => ({ code: 1, stdout: '', stderr: '' }),
        },
        { ...base, mode: 'clone', localPath: 'C:/work/app' },
      ),
    ).rejects.toThrow('git clone failed');
  });

  it('attaches an existing checkout when the path exists', async () => {
    const result = await provisionRepo(
      { pathExists: () => true, clone: async () => ({ code: 0, stdout: '', stderr: '' }) },
      { ...base, defaultBranch: null, mode: 'existing', localPath: 'C:/existing' },
    );
    expect(result.localPath).toBe('C:/existing');
    expect(result.defaultBranch).toBeNull();
  });

  it('rejects an existing checkout whose path is missing', async () => {
    await expect(
      provisionRepo(
        { pathExists: () => false, clone: async () => ({ code: 0, stdout: '', stderr: '' }) },
        { ...base, mode: 'existing', localPath: 'C:/nope' },
      ),
    ).rejects.toThrow('Path does not exist');
  });

  it('rejects a blank local path', async () => {
    await expect(
      provisionRepo(
        { pathExists: () => true, clone: async () => ({ code: 0, stdout: '', stderr: '' }) },
        { ...base, mode: 'existing', localPath: '   ' },
      ),
    ).rejects.toThrow('A local path is required');
  });
});
