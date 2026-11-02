import { describe, expect, it, vi } from 'vitest';
import { createGitBranchReader } from './feature-branch-git-adapter.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execute }));
vi.mock('node:util', () => ({ promisify: () => execute }));

describe('Git branch adapter executable ownership', () => {
  it('uses the injected path with direct argv and isolated read-only environment', async () => {
    execute.mockResolvedValue({ stdout: ' main \n' });
    expect(await createGitBranchReader('C:\\git tools\\git.exe').read('C:\\workspace with spaces')).toBe('main');
    expect(execute).toHaveBeenCalledWith('C:\\git tools\\git.exe',
      ['-c', 'safe.directory=*', '-C', 'C:\\workspace with spaces', 'rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ windowsHide: true, env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }) }));
  });

  it('preserves the default and detached/failed checkout behavior', async () => {
    execute.mockResolvedValue({ stdout: 'HEAD' });
    expect(await createGitBranchReader().read('repo')).toBeNull();
    execute.mockResolvedValue({ stdout: '' });
    expect(await createGitBranchReader().read('repo')).toBeNull();
    execute.mockRejectedValue(new Error('not a repository'));
    expect(await createGitBranchReader().read('repo')).toBeNull();
  });
});
