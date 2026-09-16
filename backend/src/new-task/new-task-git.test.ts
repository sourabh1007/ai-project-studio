import { describe, it, expect } from 'vitest';
import { basename, dirname, join } from 'node:path';
import {
  createNewTaskGit,
  newTaskBranch,
  newTaskWorktreePath,
  parseChangedFiles,
  parseNameStatus,
  type GitRunResult,
  type NewTaskGitRunner,
} from './new-task-git.js';

const OK: GitRunResult = { code: 0, stdout: '', stderr: '' };
const FAIL: GitRunResult = { code: 1, stdout: '', stderr: 'boom' };

/** A runner that returns a scripted result per call, recording the args. */
function scriptedRunner(results: GitRunResult[]): {
  git: NewTaskGitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const git: NewTaskGitRunner = async (args) => {
    calls.push(args);
    return results[i++] ?? OK;
  };
  return { git, calls };
}

describe('new-task-git helpers', () => {
  it('derives a users/<name> branch and worktree path', () => {
    expect(newTaskBranch('alice', 'Fix the bug')).toBe('users/alice/fix-the-bug');
    expect(newTaskBranch('alice', 'Fix the bug', 'x9y8abcd')).toBe(
      'users/alice/fix-the-bu-x9y8',
    );
    const repoLocalPath = join('C:', 'work', 'app');
    expect(newTaskWorktreePath(repoLocalPath, 'a1')).toBe(
      join(dirname(repoLocalPath), '.ai-worktrees', `${basename(repoLocalPath)}-task-a1`),
    );
  });

  it('clamps the name segment under the 15-char limit and sanitizes', () => {
    const branch = newTaskBranch('AL ICE', 'Refactor the authentication layer!!');
    const [, user, name] = branch.split('/');
    expect(user).toBe('al-ice');
    expect(name.length).toBeLessThanOrEqual(15);
    expect(name).toBe('refactor-the-au');
  });

  it('falls back to defaults when the inputs sanitize to nothing', () => {
    expect(newTaskBranch('', '')).toBe('users/user/task');
    expect(newTaskBranch('me', '###', '@@')).toBe('users/me/task-0');
  });

  it('exposes worktreePathFor matching the helper', () => {
    const { git } = scriptedRunner([]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    expect(port.worktreePathFor('/repo', 'a1')).toBe(
      newTaskWorktreePath('/repo', 'a1'),
    );
  });
});

describe('parseChangedFiles', () => {
  it('classifies each porcelain code and unwraps renames + quotes', () => {
    const porcelain = [
      ' M src/mod.ts',
      'A  src/new.ts',
      '?? src/untracked.ts',
      ' D src/gone.ts',
      'R  src/old.ts -> src/renamed.ts',
      '?? "src/with space.ts"',
      '',
    ].join('\n');
    expect(parseChangedFiles(porcelain)).toEqual([
      { path: 'src/mod.ts', changeType: 'modified' },
      { path: 'src/new.ts', changeType: 'added' },
      { path: 'src/untracked.ts', changeType: 'added' },
      { path: 'src/gone.ts', changeType: 'deleted' },
      { path: 'src/renamed.ts', changeType: 'renamed' },
      { path: 'src/with space.ts', changeType: 'added' },
    ]);
  });
});

describe('prepareWorktree', () => {
  it('bases the branch on the fetched remote head', async () => {
    const { git, calls } = scriptedRunner([OK, OK]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {}, resolveUser: () => 'me' });
    const result = await port.prepareWorktree({
      repoLocalPath: '/repo',
      baseBranch: 'main',
      runId: 'a1',
      name: 'fix',
    });
    expect(result.branch).toBe('users/me/fix');
    expect(calls[0]).toEqual(['-C', '/repo', 'fetch', 'origin', 'main']);
    expect(calls[1].at(-1)).toBe('origin/main');
  });

  it('falls back to the local base ref when the fetch fails', async () => {
    const { git, calls } = scriptedRunner([FAIL, OK]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {}, resolveUser: () => 'me' });
    await port.prepareWorktree({
      repoLocalPath: '/repo',
      baseBranch: 'main',
      runId: 'a1',
      name: 'fix',
    });
    expect(calls[1].at(-1)).toBe('main');
  });

  it('retries from HEAD when adding on the base ref fails', async () => {
    const { git, calls } = scriptedRunner([OK, FAIL, OK]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await port.prepareWorktree({
      repoLocalPath: '/repo',
      baseBranch: 'main',
      runId: 'a1',
      name: 'fix',
    });
    expect(calls[1].at(-1)).toBe('origin/main');
    expect(calls[2].at(-1)).toBe('HEAD');
  });

  it('throws when the worktree cannot be created at all', async () => {
    const { git } = scriptedRunner([OK, FAIL, FAIL]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.prepareWorktree({ repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix' }),
    ).rejects.toThrow('boom');
  });

  it('uses a generic message when git gives no stderr', async () => {
    const { git } = scriptedRunner([
      OK,
      { code: 1, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.prepareWorktree({ repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix' }),
    ).rejects.toThrow('Failed to create the task worktree');
  });

  it('re-plan tears down the old worktree + branch and cuts a fresh one', async () => {
    const { git, calls } = scriptedRunner([OK, OK, OK, OK, OK]);
    const port = createNewTaskGit({
      git,
      pathExists: () => false,
      removeDir: () => {},
      branchToken: () => 'tok',
      resolveUser: () => 'me',
    });
    const result = await port.prepareWorktree({
      repoLocalPath: '/repo',
      baseBranch: 'main',
      runId: 'a1',
      name: 'fix',
      previousBranch: 'users/me/fix',
    });
    expect(result.branch).toBe('users/me/fix-tok');
    expect(calls[0]).toEqual([
      '-C',
      '/repo',
      'worktree',
      'remove',
      '--force',
      newTaskWorktreePath('/repo', 'a1'),
    ]);
    expect(calls[1]).toEqual(['-C', '/repo', 'worktree', 'prune']);
    expect(calls[2]).toEqual([
      '-C',
      '/repo',
      'branch',
      '-D',
      'users/me/fix',
    ]);
    expect(calls[3]).toEqual(['-C', '/repo', 'fetch', 'origin', 'main']);
    expect(calls[4]).toContain('users/me/fix-tok');
    expect(calls[4].at(-1)).toBe('origin/main');
  });

  it('re-plan uses a random token by default', async () => {
    const { git } = scriptedRunner([OK, OK, OK, OK, OK]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {}, resolveUser: () => 'me' });
    const result = await port.prepareWorktree({
      repoLocalPath: '/repo',
      baseBranch: 'main',
      runId: 'a1',
      name: 'fix',
      previousBranch: 'users/me/fix',
    });
    expect(result.branch).toMatch(/^users\/me\/fix-[0-9a-f]{4}$/);
  });

  it('purges a leftover worktree directory and prunes before adding', async () => {
    const { git, calls } = scriptedRunner([OK, OK, OK]);
    const removed: string[] = [];
    const port = createNewTaskGit({
      git,
      pathExists: () => true,
      removeDir: (path) => removed.push(path),
      resolveUser: () => 'me',
    });
    const result = await port.prepareWorktree({
      repoLocalPath: '/repo',
      baseBranch: 'main',
      runId: 'a1',
      name: 'fix',
    });
    expect(removed).toEqual([newTaskWorktreePath('/repo', 'a1')]);
    expect(calls[0]).toEqual(['-C', '/repo', 'worktree', 'prune']);
    expect(calls[1]).toEqual(['-C', '/repo', 'fetch', 'origin', 'main']);
    expect(result.branch).toBe('users/me/fix');
  });
});

describe('commitAll', () => {
  it('returns not-committed when the worktree is clean', async () => {
    const { git } = scriptedRunner([{ code: 0, stdout: '\n', stderr: '' }]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    expect(
      await port.commitAll({ worktreePath: '/wt', message: 'm' }),
    ).toEqual({ committed: false, files: [] });
  });

  it('stages and commits when there are changes, reporting the files', async () => {
    const { git, calls } = scriptedRunner([
      { code: 0, stdout: ' M file.ts\n?? added.ts\n', stderr: '' },
      OK,
      OK,
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    expect(await port.commitAll({ worktreePath: '/wt', message: 'm' })).toEqual({
      committed: true,
      files: [
        { path: 'file.ts', changeType: 'modified' },
        { path: 'added.ts', changeType: 'added' },
      ],
    });
    expect(calls[1]).toEqual(['-C', '/wt', 'add', '-A']);
    expect(calls[2]).toEqual(['-C', '/wt', 'commit', '-m', 'm']);
  });

  it('throws when status fails', async () => {
    const { git } = scriptedRunner([FAIL]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.commitAll({ worktreePath: '/wt', message: 'm' }),
    ).rejects.toThrow('boom');
  });

  it('throws when staging fails', async () => {
    const { git } = scriptedRunner([
      { code: 0, stdout: ' M f\n', stderr: '' },
      { code: 1, stdout: '', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.commitAll({ worktreePath: '/wt', message: 'm' }),
    ).rejects.toThrow('Failed to stage the change');
  });

  it('throws when committing fails', async () => {
    const { git } = scriptedRunner([
      { code: 0, stdout: ' M f\n', stderr: '' },
      OK,
      { code: 1, stdout: '', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.commitAll({ worktreePath: '/wt', message: 'm' }),
    ).rejects.toThrow('Failed to commit the change');
  });

  it('surfaces a generic message when status has no stderr', async () => {
    const { git } = scriptedRunner([{ code: 1, stdout: '', stderr: '' }]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.commitAll({ worktreePath: '/wt', message: 'm' }),
    ).rejects.toThrow('Failed to inspect the worktree');
  });
});

describe('pushBranch', () => {
  it('pushes the branch upstream', async () => {
    const { git, calls } = scriptedRunner([OK]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await port.pushBranch({ worktreePath: '/wt', branch: 'b' });
    expect(calls[0]).toEqual(['-C', '/wt', 'push', '-u', 'origin', 'b']);
  });

  it('throws when the push fails', async () => {
    const { git } = scriptedRunner([FAIL]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.pushBranch({ worktreePath: '/wt', branch: 'b' }),
    ).rejects.toThrow('boom');
  });

  it('uses a generic message when the push has no stderr', async () => {
    const { git } = scriptedRunner([{ code: 1, stdout: '', stderr: '' }]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.pushBranch({ worktreePath: '/wt', branch: 'b' }),
    ).rejects.toThrow('Failed to push the branch');
  });
});

describe('parseNameStatus', () => {
  it('classifies each diff status and reports the final rename path', () => {
    const out = [
      'M\tsrc/mod.ts',
      'A\tsrc/new.ts',
      'D\tsrc/gone.ts',
      'R100\tsrc/old.ts\tsrc/renamed.ts',
      'C075\tsrc/base.ts\tsrc/copy.ts',
      'T\tsrc/type.ts',
      '',
    ].join('\n');
    expect(parseNameStatus(out)).toEqual([
      { path: 'src/mod.ts', changeType: 'modified' },
      { path: 'src/new.ts', changeType: 'added' },
      { path: 'src/gone.ts', changeType: 'deleted' },
      { path: 'src/renamed.ts', changeType: 'renamed' },
      { path: 'src/copy.ts', changeType: 'renamed' },
      { path: 'src/type.ts', changeType: 'modified' },
    ]);
  });
});

describe('changedFilesAgainst', () => {
  it('diffs the branch against its base and parses the summary', async () => {
    const { git, calls } = scriptedRunner([
      { code: 0, stdout: 'M\tsrc/a.ts\n', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    const files = await port.changedFilesAgainst({
      worktreePath: '/wt',
      baseBranch: 'main',
    });
    expect(calls[0]).toEqual([
      '-C', '/wt', 'diff', '--name-status', 'main...HEAD',
    ]);
    expect(files).toEqual([{ path: 'src/a.ts', changeType: 'modified' }]);
  });

  it('throws when the diff fails', async () => {
    const { git } = scriptedRunner([FAIL]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.changedFilesAgainst({ worktreePath: '/wt', baseBranch: 'main' }),
    ).rejects.toThrow('boom');
  });

  it('uses a generic message when the diff has no stderr', async () => {
    const { git } = scriptedRunner([{ code: 1, stdout: '', stderr: '' }]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.changedFilesAgainst({ worktreePath: '/wt', baseBranch: 'main' }),
    ).rejects.toThrow('Failed to inspect the branch');
  });
});

describe('fileDiff', () => {
  it('returns the diff and full branch content for a file', async () => {
    const { git, calls } = scriptedRunner([
      { code: 0, stdout: '@@ -1 +1 @@\n-old\n+new\n', stderr: '' },
      { code: 0, stdout: 'new\n', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    const result = await port.fileDiff({
      worktreePath: '/wt',
      baseBranch: 'main',
      path: 'src/a.ts',
    });
    expect(calls[0]).toEqual([
      '-C', '/wt', 'diff', 'main...HEAD', '--', 'src/a.ts',
    ]);
    expect(calls[1]).toEqual(['-C', '/wt', 'show', 'HEAD:src/a.ts']);
    expect(result).toEqual({
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@\n-old\n+new\n',
      content: 'new\n',
    });
  });

  it('degrades to empty content when the file no longer exists', async () => {
    const { git } = scriptedRunner([
      { code: 0, stdout: 'diff', stderr: '' },
      { code: 1, stdout: '', stderr: 'missing' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    const result = await port.fileDiff({
      worktreePath: '/wt',
      baseBranch: 'main',
      path: 'src/gone.ts',
    });
    expect(result.content).toBe('');
    expect(result.diff).toBe('diff');
  });

  it('throws when the diff fails', async () => {
    const { git } = scriptedRunner([FAIL]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.fileDiff({ worktreePath: '/wt', baseBranch: 'main', path: 'a' }),
    ).rejects.toThrow('boom');
  });

  it('uses a generic message when the diff has no stderr', async () => {
    const { git } = scriptedRunner([{ code: 1, stdout: '', stderr: '' }]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.fileDiff({ worktreePath: '/wt', baseBranch: 'main', path: 'a' }),
    ).rejects.toThrow('Failed to diff the file');
  });
});
