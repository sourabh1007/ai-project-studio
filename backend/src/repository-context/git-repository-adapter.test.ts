import { describe, expect, it, vi } from 'vitest';
import { createGitRepositoryAdapter } from './git-repository-adapter.js';

describe('git repository adapter', () => {
  it('uses only read-only Git inspection commands', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: '0123456789abcdef0123456789abcdef01234567\n',
      })
      .mockResolvedValueOnce({ stdout: Buffer.from('a.ts\0docs/readme.md\0') });
    const adapter = createGitRepositoryAdapter({ run });

    await expect(adapter.getRevision('C:\\repo')).resolves.toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    await expect(adapter.listTrackedFiles('C:\\repo')).resolves.toEqual([
      'a.ts',
      'docs/readme.md',
    ]);
    expect(run).toHaveBeenNthCalledWith(1, 'git', [
      '-C',
      'C:\\repo',
      'rev-parse',
      '--verify',
      'HEAD',
    ]);
    expect(run).toHaveBeenNthCalledWith(2, 'git', [
      '-C',
      'C:\\repo',
      'ls-files',
      '-z',
    ]);
  });

  it('rejects invalid revisions and propagates Git failures', async () => {
    const invalid = createGitRepositoryAdapter({
      run: vi.fn().mockResolvedValue({ stdout: 'not-a-revision' }),
    });
    await expect(invalid.getRevision('repo')).rejects.toThrow(
      'invalid HEAD revision',
    );

    const failure = new Error('not a repository');
    const failed = createGitRepositoryAdapter({
      run: vi.fn().mockRejectedValue(failure),
    });
    await expect(failed.listTrackedFiles('repo')).rejects.toBe(failure);
  });
});
