import { describe, it, expect } from 'vitest';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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
  it('resumes its actual dirty worktree without resetting branches or deleting user work', async () => {
    const root = join(process.cwd(), `.new-task-recovery-${randomUUID()}`);
    const repoLocalPath = join(root, 'repo');
    mkdirSync(repoLocalPath, { recursive: true });
    const gitCommand = (...args: string[]) =>
      execFileSync('git', ['-C', repoLocalPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      gitCommand('init', '--initial-branch=main');
      gitCommand('config', 'user.name', 'Local regression');
      gitCommand('config', 'user.email', 'regression@example.invalid');
      gitCommand('config', 'commit.gpgsign', 'false');
      gitCommand('config', 'core.hooksPath', join(root, 'disabled-hooks'));
      writeFileSync(join(repoLocalPath, 'base.txt'), 'base');
      writeFileSync(join(repoLocalPath, '.gitignore'), '*.local\n');
      gitCommand('add', '.');
      gitCommand('commit', '-m', 'local fixture');
      const port = createNewTaskGit({
        git: async (args) => {
          const result = spawnSync('git', args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
          return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
        pathExists: existsSync,
        removeDir: () => { throw new Error('Must never delete files'); },
        resolveUser: () => 'me',
        branchToken: () => 'next',
      });
      const input = { repoLocalPath, baseBranch: 'main', runId: 'run-1', name: 'fix' };
      const first = await port.prepareWorktree(input);
      writeFileSync(join(first.worktreePath, 'user-work.txt'), 'Uncommitted user work');
      await expect(port.prepareWorktree(input)).resolves.toEqual(first);
      await expect(port.prepareWorktree({ ...input, previousBranch: first.branch, resume: true })).resolves.toEqual(first);
      await expect(port.prepareWorktree({ ...input, previousBranch: first.branch })).rejects.toMatchObject({ kind: 'conflict' });
      await expect(port.prepareWorktree({ ...input, runId: 'different-run' })).rejects.toThrow();
      expect(readFileSync(join(first.worktreePath, 'user-work.txt'), 'utf8')).toBe('Uncommitted user work');
      expect(gitCommand('branch', '--show-current')).toBe('main');
      execFileSync('git', ['-C', first.worktreePath, 'add', '.']);
      execFileSync('git', ['-C', first.worktreePath, 'commit', '-m', 'Preserve this work'], { stdio: 'pipe' });
      writeFileSync(join(first.worktreePath, 'private.local'), 'Ignored user work');
      await expect(port.prepareWorktree({ ...input, previousBranch: first.branch })).rejects.toMatchObject({ kind: 'conflict' });
      expect(readFileSync(join(first.worktreePath, 'private.local'), 'utf8')).toBe('Ignored user work');
      rmSync(join(first.worktreePath, 'private.local'));
      const replanned = await port.prepareWorktree({ ...input, previousBranch: first.branch });
      expect(replanned.branch).not.toBe(first.branch);
      expect(gitCommand('show', `${first.branch}:user-work.txt`)).toBe('Uncommitted user work');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

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

  it('re-plan removes only the clean worktree and preserves the old branch', async () => {
    const worktreePath = newTaskWorktreePath('/repo', 'a1');
    const { git, calls } = scriptedRunner([
      { ...OK, stdout: `worktree ${worktreePath}\nHEAD abc\nbranch refs/heads/users/me/fix\n\n` },
      OK, OK, OK, OK,
    ]);
    const port = createNewTaskGit({
      git,
      pathExists: () => true,
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
      '-C', '/repo', 'worktree', 'list', '--porcelain',
    ]);
    expect(calls[1]).toEqual(['-C', worktreePath, 'status', '--porcelain', '--untracked-files=all', '--ignored']);
    expect(calls[2]).toEqual(['-C', '/repo', 'worktree', 'remove', worktreePath]);
    expect(calls[3]).toEqual(['-C', '/repo', 'fetch', 'origin', 'main']);
    expect(calls[4]).toContain('users/me/fix-tok');
    expect(calls[4]).toContain('-b');
    expect(calls[4].at(-1)).toBe('origin/main');
    expect(calls.flat()).not.toContain('-D');
    expect(calls.flat()).not.toContain('--force');
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

  it('refuses an unregistered leftover directory without deleting files', async () => {
    const { git, calls } = scriptedRunner([OK]);
    const removed: string[] = [];
    const port = createNewTaskGit({
      git,
      pathExists: () => true,
      removeDir: (path) => removed.push(path),
      resolveUser: () => 'me',
    });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo',
      baseBranch: 'main',
      runId: 'a1',
      name: 'fix',
    })).rejects.toMatchObject({ kind: 'conflict' });
    expect(removed).toEqual([]);
    expect(calls).toEqual([['-C', '/repo', 'worktree', 'list', '--porcelain']]);
  });

  it.each([undefined, 'users/me/fix'])('reuses the verified run worktree on retry (%s)', async (previousBranch) => {
    const worktreePath = newTaskWorktreePath('/repo', 'a1');
    const { git, calls } = scriptedRunner([
      { ...OK, stdout: `worktree /other\nbranch refs/heads/other\n\nworktree ${worktreePath}\nHEAD abc\nbranch refs/heads/users/me/fix\n\n` },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => true, removeDir: () => { throw new Error('must preserve files'); }, resolveUser: () => 'me' });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix',
      previousBranch, resume: true,
    })).resolves.toEqual({ worktreePath, branch: 'users/me/fix' });
    expect(calls).toHaveLength(1);
  });

  it('restores a missing worktree only from the branch persisted on that run', async () => {
    const { git, calls } = scriptedRunner([OK]);
    const port = createNewTaskGit({ git, pathExists: () => false, removeDir: () => {} });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix',
      previousBranch: 'users/me/fix', resume: true,
    })).resolves.toEqual({ worktreePath: newTaskWorktreePath('/repo', 'a1'), branch: 'users/me/fix' });
    expect(calls).toEqual([['-C', '/repo', 'worktree', 'add', newTaskWorktreePath('/repo', 'a1'), 'users/me/fix']]);
  });

  it.each(['boom', ''])('reports a worktree resume failure without selecting a different branch (%s)', async (stderr) => {
    const { git, calls } = scriptedRunner([{ ...FAIL, stderr }]);
    const port = createNewTaskGit({ git, pathExists: () => false, removeDir: () => {} });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix',
      previousBranch: 'users/me/fix', resume: true,
    })).rejects.toThrow(stderr || 'Failed to resume the task worktree');
    expect(calls).toHaveLength(1);
  });

  it.each(['boom', ''])('does not remove a worktree when inspection fails (%s)', async (stderr) => {
    const { git, calls } = scriptedRunner([{ ...FAIL, stderr }]);
    const port = createNewTaskGit({ git, pathExists: () => true, removeDir: () => {} });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix',
    })).rejects.toThrow(stderr || 'Failed to inspect the task worktree');
    expect(calls).toHaveLength(1);
  });

  it.each(['boom', ''])('stops re-planning when git refuses safe removal (%s)', async (stderr) => {
    const worktreePath = newTaskWorktreePath('/repo', 'a1');
    const { git, calls } = scriptedRunner([
      { ...OK, stdout: `worktree ${worktreePath}\nbranch refs/heads/users/me/fix\n\n` },
      OK,
      { ...FAIL, stderr },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => true, removeDir: () => {} });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix',
      previousBranch: 'users/me/fix',
    })).rejects.toThrow(stderr || 'The task worktree contains work that must be preserved.');
    expect(calls).toHaveLength(3);
    expect(calls.flat()).not.toContain('--force');
  });

  it.each(['boom', ''])('preserves the worktree when inspecting local changes fails (%s)', async (stderr) => {
    const worktreePath = newTaskWorktreePath('/repo', 'a1');
    const { git, calls } = scriptedRunner([
      { ...OK, stdout: `worktree ${worktreePath}\nbranch refs/heads/users/me/fix\n\n` },
      { ...FAIL, stderr },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => true, removeDir: () => {} });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix',
      previousBranch: 'users/me/fix',
    })).rejects.toThrow(stderr || 'Failed to inspect worktree changes');
    expect(calls).toHaveLength(2);
  });

  it('refuses a registered path on an unexpected branch', async () => {
    const worktreePath = newTaskWorktreePath('/repo', 'a1');
    const { git, calls } = scriptedRunner([
      { ...OK, stdout: `worktree ${worktreePath}\nbranch refs/heads/user-work\n\n` },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => true, removeDir: () => {} });
    await expect(port.prepareWorktree({
      repoLocalPath: '/repo', baseBranch: 'main', runId: 'a1', name: 'fix', resume: true,
    })).rejects.toMatchObject({ kind: 'conflict' });
    expect(calls).toHaveLength(1);
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
  it('resolves the remote base ref and parses the summary', async () => {
    const { git, calls } = scriptedRunner([
      { code: 0, stdout: 'abc123\n', stderr: '' },
      { code: 0, stdout: 'M\tsrc/a.ts\n', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    const files = await port.changedFilesAgainst({
      worktreePath: '/wt',
      baseBranch: 'main',
    });
    expect(calls[0]).toEqual([
      '-C', '/wt', 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}',
    ]);
    expect(calls[1]).toEqual([
      '-C', '/wt', 'diff', '--name-status', 'abc123...HEAD',
    ]);
    expect(files).toEqual([{ path: 'src/a.ts', changeType: 'modified' }]);
  });

  it('falls back to the local base ref when origin is blank', async () => {
    const { git, calls } = scriptedRunner([
      { code: 0, stdout: '   \n', stderr: '' },
      { code: 0, stdout: 'def456\n', stderr: '' },
      { code: 0, stdout: 'A\tsrc/b.ts\n', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    const files = await port.changedFilesAgainst({
      worktreePath: '/wt',
      baseBranch: 'main',
    });
    expect(calls[1]).toEqual([
      '-C', '/wt', 'rev-parse', '--verify', '--quiet', 'main^{commit}',
    ]);
    expect(calls[2]).toEqual([
      '-C', '/wt', 'diff', '--name-status', 'def456...HEAD',
    ]);
    expect(files).toEqual([{ path: 'src/b.ts', changeType: 'added' }]);
  });

  it('falls back to HEAD when no base ref resolves', async () => {
    const { git, calls } = scriptedRunner([
      { code: 1, stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await port.changedFilesAgainst({ worktreePath: '/wt', baseBranch: 'main' });
    expect(calls[2]).toEqual([
      '-C', '/wt', 'diff', '--name-status', 'HEAD...HEAD',
    ]);
  });

  it('throws when the diff fails', async () => {
    const { git } = scriptedRunner([{ code: 0, stdout: 'abc\n', stderr: '' }, FAIL]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.changedFilesAgainst({ worktreePath: '/wt', baseBranch: 'main' }),
    ).rejects.toThrow('boom');
  });

  it('uses a generic message when the diff has no stderr', async () => {
    const { git } = scriptedRunner([
      { code: 0, stdout: 'abc\n', stderr: '' },
      { code: 1, stdout: '', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.changedFilesAgainst({ worktreePath: '/wt', baseBranch: 'main' }),
    ).rejects.toThrow('Failed to inspect the branch');
  });
});

describe('fileDiff', () => {
  it('returns the live (working-tree) diff and full branch content', async () => {
    const { git, calls } = scriptedRunner([
      { code: 0, stdout: 'abc123\n', stderr: '' },
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
      '-C', '/wt', 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}',
    ]);
    expect(calls[1]).toEqual([
      '-C', '/wt', 'diff', 'abc123', '--', 'src/a.ts',
    ]);
    expect(calls[2]).toEqual(['-C', '/wt', 'show', 'HEAD:src/a.ts']);
    expect(result).toEqual({
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@\n-old\n+new\n',
      content: 'new\n',
    });
  });

  it('degrades to empty content when the file no longer exists', async () => {
    const { git } = scriptedRunner([
      { code: 0, stdout: 'abc\n', stderr: '' },
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
    const { git } = scriptedRunner([{ code: 0, stdout: 'abc\n', stderr: '' }, FAIL]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.fileDiff({ worktreePath: '/wt', baseBranch: 'main', path: 'a' }),
    ).rejects.toThrow('boom');
  });

  it('uses a generic message when the diff has no stderr', async () => {
    const { git } = scriptedRunner([
      { code: 0, stdout: 'abc\n', stderr: '' },
      { code: 1, stdout: '', stderr: '' },
    ]);
    const port = createNewTaskGit({ git, pathExists: () => false,
      removeDir: () => {} });
    await expect(
      port.fileDiff({ worktreePath: '/wt', baseBranch: 'main', path: 'a' }),
    ).rejects.toThrow('Failed to diff the file');
  });
});
