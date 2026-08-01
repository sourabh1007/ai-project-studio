import { describe, it, expect } from 'vitest';
import { join, dirname, basename } from 'node:path';
import {
  provisionPrWorktree,
  prWorktreePath,
  type GitRunResult,
} from './pr-worktree-provisioner.js';

const ok: GitRunResult = { code: 0, stdout: '', stderr: '' };

function gitRecorder(results: GitRunResult[]) {
  const calls: string[][] = [];
  let i = 0;
  const git = (args: string[]): Promise<GitRunResult> => {
    calls.push(args);
    return Promise.resolve(results[i++] ?? ok);
  };
  return { git, calls };
}

const repoLocalPath = join('C:', 'work', 'app');

describe('prWorktreePath', () => {
  it('places the worktree in a sibling .ai-worktrees directory', () => {
    expect(prWorktreePath(repoLocalPath, 12)).toBe(
      join(dirname(repoLocalPath), '.ai-worktrees', `${basename(repoLocalPath)}-pr-12`),
    );
  });
});

describe('provisionPrWorktree', () => {
  it('fetches the GitHub pull ref and adds a worktree', async () => {
    const { git, calls } = gitRecorder([ok, ok]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'ignored' },
    );
    const worktreePath = prWorktreePath(repoLocalPath, 12);
    expect(result).toEqual({ worktreePath, branch: 'pr-12' });
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      'pull/12/head:pr-12',
    ]);
    expect(calls[1]).toEqual([
      '-C',
      repoLocalPath,
      'worktree',
      'add',
      worktreePath,
      'pr-12',
    ]);
  });

  it('fetches the Azure source branch', async () => {
    const { git, calls } = gitRecorder([ok, ok]);
    await provisionPrWorktree(
      { git, pathExists: () => false },
      {
        repoLocalPath,
        provider: 'azure-devops',
        number: 7,
        sourceBranch: 'topic/x',
      },
    );
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      'topic/x:pr-7',
    ]);
  });

  it('reuses an existing worktree without running git', async () => {
    const { git, calls } = gitRecorder([]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => true },
      { repoLocalPath, provider: 'github', number: 3, sourceBranch: 'b' },
    );
    expect(result.branch).toBe('pr-3');
    expect(calls).toHaveLength(0);
  });

  it('throws when the fetch fails', async () => {
    const { git } = gitRecorder([{ code: 1, stdout: '', stderr: 'no ref' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('no ref');
  });

  it('throws a default message when fetch fails without stderr', async () => {
    const { git } = gitRecorder([{ code: 1, stdout: '', stderr: '' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('Failed to fetch pull request #9');
  });

  it('throws when the worktree add fails', async () => {
    const { git } = gitRecorder([ok, { code: 1, stdout: '', stderr: 'busy' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('busy');
  });

  it('throws a default message when worktree add fails without stderr', async () => {
    const { git } = gitRecorder([ok, { code: 1, stdout: '', stderr: '' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('Failed to create the review worktree');
  });
});
