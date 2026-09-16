import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktreeService } from './worktree-service.js';
import type { Repository } from '../repo/repo-contract.js';
import type { GitRunResult } from '../repo/pr-worktree-provisioner.js';

function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'r1',
    provider: 'github',
    remoteUrl: 'https://example/app',
    name: 'owner/app',
    localPath: '/repos/app',
    defaultBranch: 'main',
    createdAt: '',
    ...overrides,
  };
}

const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '' });

function harness(options: {
  repos?: Repository[];
  review?: { repoId: string; worktreePath: string } | null;
  run?: (args: string[], cwd: string) => Promise<GitRunResult>;
  removeDir?: (path: string) => Promise<void>;
}) {
  const calls: { args: string[]; cwd: string }[] = [];
  const removedDirs: string[] = [];
  const run =
    options.run ??
    (async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (args[1] === 'list') {
        return ok(
          'worktree /repos/app\nHEAD a\nbranch refs/heads/main\n\n' +
            'worktree /repos/.ai-worktrees/app-pr-7\nHEAD b\nbranch refs/heads/pr-7\n',
        );
      }
      return ok();
    });
  const service = createWorktreeService({
    repos: {
      list: () => options.repos ?? [repo()],
      get: (id) => (options.repos ?? [repo()]).find((r) => r.id === id) ?? null,
    },
    reviews: { find: () => options.review ?? null },
    git: { run: (args, cwd) => (calls.push({ args, cwd }), run(args, cwd)) },
    removeDir:
      options.removeDir ??
      (async (path: string) => {
        removedDirs.push(path);
      }),
  });
  return { service, calls, removedDirs };
}

describe('createWorktreeService.list', () => {
  it('returns only app-managed worktrees enriched with repo + PR info', async () => {
    const { service } = harness({});
    expect(await service.list()).toEqual([
      {
        path: '/repos/.ai-worktrees/app-pr-7',
        branch: 'pr-7',
        repoId: 'r1',
        repoName: 'owner/app',
        pullNumber: 7,
      },
    ]);
  });

  it('skips repositories whose git listing fails', async () => {
    const { service } = harness({ run: async () => ({ code: 1, stdout: '', stderr: 'x' }) });
    expect(await service.list()).toEqual([]);
  });
});

describe('createWorktreeService.remove', () => {
  it('removes and prunes the owning repository worktree', async () => {
    const { service, calls, removedDirs } = harness({});
    await service.remove('/repos/.ai-worktrees/app-pr-7');
    const gitCalls = calls.map((c) => c.args.join(' '));
    expect(gitCalls).toContain('worktree remove --force /repos/.ai-worktrees/app-pr-7');
    expect(gitCalls).toContain('worktree prune');
    // The checkout directory must be deleted from disk, not just unregistered.
    expect(removedDirs).toContain('/repos/.ai-worktrees/app-pr-7');
  });

  it('removes a New Task worktree named with the -task- prefix', async () => {
    const { service, calls } = harness({});
    await service.remove(
      '/repos/.ai-worktrees/app-task-b8094ae7-d4ea-4533-911d-48b2654844b9',
    );
    const gitCalls = calls.map((c) => c.args.join(' '));
    expect(gitCalls).toContain(
      'worktree remove --force /repos/.ai-worktrees/app-task-b8094ae7-d4ea-4533-911d-48b2654844b9',
    );
    expect(gitCalls).toContain('worktree prune');
  });

  it('does nothing when no repository owns the path', async () => {
    const run = vi.fn(async () => ok());
    const { service } = harness({ run });
    await service.remove('/somewhere/else/pr-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('deletes the checkout from disk with the default remover', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wt-svc-'));
    try {
      const repoLocalPath = join(base, 'app');
      const worktreePath = join(base, '.ai-worktrees', 'app-task-1');
      await mkdir(worktreePath, { recursive: true });
      const service = createWorktreeService({
        repos: {
          list: () => [repo({ localPath: repoLocalPath })],
          get: () => repo({ localPath: repoLocalPath }),
        },
        reviews: { find: () => null },
        git: { run: async () => ok() },
        // No removeDir → exercises the real fs-backed default.
      });
      await service.remove(worktreePath);
      await expect(stat(worktreePath)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('createWorktreeService.removeForFeature', () => {
  it('removes the worktree resolved from the feature review', async () => {
    const { service, calls } = harness({
      review: { repoId: 'r1', worktreePath: '/repos/.ai-worktrees/app-pr-7' },
    });
    await service.removeForFeature('f1');
    expect(calls.some((c) => c.args.join(' ').includes('worktree remove'))).toBe(true);
  });

  it('does nothing when the feature has no review', async () => {
    const run = vi.fn(async () => ok());
    const { service } = harness({ review: null, run });
    await service.removeForFeature('f1');
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing when the review targets an unknown repository', async () => {
    const run = vi.fn(async () => ok());
    const { service } = harness({
      review: { repoId: 'missing', worktreePath: '/x' },
      run,
    });
    await service.removeForFeature('f1');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not remove an in-place review that used the repo primary checkout', async () => {
    const run = vi.fn(async () => ok());
    const { service } = harness({
      review: { repoId: 'r1', worktreePath: '/repos/app' },
      run,
    });
    await service.removeForFeature('f1');
    expect(run).not.toHaveBeenCalled();
  });
});
