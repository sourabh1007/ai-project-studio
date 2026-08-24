import { describe, it, expect } from 'vitest';
import { join, dirname, basename } from 'node:path';
import {
  provisionPrWorktree,
  prWorktreePath,
  describeWorktreeFailure,
  describeFetchFailure,
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
  it('checks out the GitHub PR head branch tracking origin and adds a forced worktree', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'abc123\n', stderr: '' }]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'feature-x' },
    );
    const worktreePath = prWorktreePath(repoLocalPath, 12);
    expect(result).toEqual({
      worktreePath,
      branch: 'feature-x',
      tracksPullRequest: true,
      headSha: 'abc123',
    });
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      'pull/12/head',
    ]);
    expect(calls[1]).toEqual(['-C', repoLocalPath, 'rev-parse', 'FETCH_HEAD']);
    expect(calls[2]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      '+feature-x:refs/remotes/origin/feature-x',
    ]);
    expect(calls[3]).toEqual([
      '-c',
      'core.longpaths=true',
      '-C',
      repoLocalPath,
      'worktree',
      'add',
      '--force',
      '-B',
      'feature-x',
      worktreePath,
      'abc123',
    ]);
    expect(calls[4]).toEqual([
      '-C',
      worktreePath,
      'branch',
      '--set-upstream-to=origin/feature-x',
      'feature-x',
    ]);
  });

  it('falls back to a detached pr-<n> branch when the head branch is not on origin (fork PR)', async () => {
    const { git, calls } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc123\n', stderr: '' },
      { code: 1, stdout: '', stderr: "couldn't find remote ref feature-x" },
    ]);
    const worktreePath = prWorktreePath(repoLocalPath, 12);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'feature-x' },
    );
    expect(result).toEqual({
      worktreePath,
      branch: 'pr-12',
      tracksPullRequest: false,
      headSha: 'abc123',
    });
    expect(calls[3][calls[3].length - 2]).toBe(worktreePath);
    expect(calls[3]).toContain('pr-12');
    // No upstream is set for a fork fallback.
    expect(calls).toHaveLength(4);
  });

  it('does not attempt tracking when the source branch is unknown', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'abc\n', stderr: '' }]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 9, sourceBranch: '' },
    );
    expect(result.branch).toBe('pr-9');
    expect(result.tracksPullRequest).toBe(false);
    // fetch head, rev-parse, worktree add — no track fetch, no set-upstream.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain('worktree');
  });

  it('checks out the Azure source branch tracking origin', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'abc123\n', stderr: '' }]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      {
        repoLocalPath,
        provider: 'azure-devops',
        number: 7,
        sourceBranch: 'topic/x',
      },
    );
    expect(result.branch).toBe('topic/x');
    expect(result.tracksPullRequest).toBe(true);
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      'topic/x',
    ]);
    expect(calls[2]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      '+topic/x:refs/remotes/origin/topic/x',
    ]);
  });

  it('falls back to the PR merge ref then a detached branch when the Azure source branch is not resolvable', async () => {
    const { git, calls } = gitRecorder([
      { code: 1, stdout: '', stderr: "fatal: couldn't find remote ref topic/x" },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'sha789\n', stderr: '' },
      { code: 1, stdout: '', stderr: 'no branch' },
    ]);
    const worktreePath = prWorktreePath(repoLocalPath, 7);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
    );
    expect(result).toEqual({
      worktreePath,
      branch: 'pr-7',
      tracksPullRequest: false,
      headSha: 'sha789',
    });
    expect(calls[0]).toEqual(['-C', repoLocalPath, 'fetch', 'origin', 'topic/x']);
    expect(calls[1]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      'refs/pull/7/merge',
    ]);
    expect(calls[2]).toEqual(['-C', repoLocalPath, 'rev-parse', 'FETCH_HEAD']);
    expect(calls[3]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      '+topic/x:refs/remotes/origin/topic/x',
    ]);
    expect(calls[4][calls[4].length - 1]).toBe('sha789');
  });

  it('surfaces favourite/publish guidance when no Azure ref can be fetched', async () => {
    const { git } = gitRecorder([
      { code: 1, stdout: '', stderr: "fatal: couldn't find remote ref topic/x" },
      {
        code: 1,
        stdout: '',
        stderr: "fatal: couldn't find remote ref refs/pull/7/merge",
      },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
      ),
    ).rejects.toThrow(/favourite \/ publish it/i);
  });

  it('reuses an existing worktree, force-switching it to the freshly fetched head branch', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'def456\n', stderr: '' }]);
    const worktreePath = prWorktreePath(repoLocalPath, 3);
    const result = await provisionPrWorktree(
      { git, pathExists: () => true },
      { repoLocalPath, provider: 'github', number: 3, sourceBranch: 'feat' },
    );
    expect(result).toEqual({
      worktreePath,
      branch: 'feat',
      tracksPullRequest: true,
      headSha: 'def456',
    });
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      'origin',
      'pull/3/head',
    ]);
    expect(calls[1]).toEqual(['-C', repoLocalPath, 'rev-parse', 'FETCH_HEAD']);
    expect(calls[3]).toEqual([
      '-c',
      'core.longpaths=true',
      '-C',
      worktreePath,
      'checkout',
      '-f',
      '-B',
      'feat',
      'def456',
    ]);
    expect(calls[4]).toEqual([
      '-C',
      worktreePath,
      'branch',
      '--set-upstream-to=origin/feat',
      'feat',
    ]);
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

  it('throws when resolving the fetched head fails', async () => {
    const { git } = gitRecorder([ok, { code: 1, stdout: '', stderr: 'bad rev' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('bad rev');
  });

  it('throws a default message when rev-parse fails without stderr', async () => {
    const { git } = gitRecorder([ok, { code: 1, stdout: '', stderr: '' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('Failed to resolve the fetched head for pull request #9');
  });

  it('throws when the checkout fails for an existing worktree', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      { code: 1, stdout: '', stderr: 'dirty' },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => true },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('dirty');
  });

  it('throws a default message when the checkout fails without stderr', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      { code: 1, stdout: '', stderr: '' },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => true },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('Failed to update the review worktree');
  });

  it('throws when the worktree add fails', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      { code: 1, stdout: '', stderr: 'busy' },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('busy');
  });

  it('surfaces a long-path guidance message when the checkout hits MAX_PATH', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      {
        code: 1,
        stdout: '',
        stderr:
          "error: unable to create file Product/Backend/x: Filename too long",
      },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow(/long paths/i);
  });
});

describe('describeWorktreeFailure', () => {
  it('explains the Windows long-path limit for "Filename too long"', () => {
    expect(describeWorktreeFailure('Filename too long', 'fallback')).toMatch(
      /LongPathsEnabled/,
    );
  });

  it('explains it for "unable to create file" too', () => {
    expect(
      describeWorktreeFailure('error: unable to create file foo', 'fallback'),
    ).toMatch(/long paths/i);
  });

  it('passes other stderr through unchanged', () => {
    expect(describeWorktreeFailure('some other error', 'fallback')).toBe(
      'some other error',
    );
  });

  it('falls back when stderr is empty', () => {
    expect(describeWorktreeFailure('   ', 'fallback message')).toBe(
      'fallback message',
    );
  });
});

describe('describeFetchFailure', () => {
  const base = {
    repoLocalPath,
    provider: 'azure-devops' as const,
    number: 7,
    sourceBranch: 'topic/x',
  };

  it('gives favourite/publish guidance for an unresolvable Azure ref', () => {
    expect(
      describeFetchFailure(base, "fatal: couldn't find remote ref topic/x"),
    ).toMatch(/favourite \/ publish it/i);
  });

  it('passes other Azure fetch errors through unchanged', () => {
    expect(describeFetchFailure(base, 'fatal: authentication failed')).toBe(
      'fatal: authentication failed',
    );
  });

  it('passes GitHub fetch errors through unchanged', () => {
    expect(
      describeFetchFailure(
        { ...base, provider: 'github' },
        "fatal: couldn't find remote ref pull/7/head",
      ),
    ).toBe("fatal: couldn't find remote ref pull/7/head");
  });

  it('falls back to a default message when stderr is empty', () => {
    expect(describeFetchFailure(base, '   ')).toBe(
      'Failed to fetch pull request #7',
    );
  });
});
