import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
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
  directories?: string[];
  isBusy?: (path: string) => boolean | Promise<boolean>;
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
    listCheckoutDirectories: options.directories ? async () => options.directories! : undefined,
    git: { run: (args, cwd) => (calls.push({ args, cwd }), run(args, cwd)) },
    isBusy: options.isBusy,
    removeDir:
      options.removeDir ??
      (async (path: string) => {
        removedDirs.push(path);
      }),
  });
  return { service, calls, removedDirs };
}

describe('createWorktreeService.list', () => {
  it.each(['Git timed out', ''])('reports repository inventory errors to cancellable scans: %s', async (stderr) => {
    const { service } = harness({ run: async () => ({ code: 1, stdout: '', stderr }) });
    await expect(service.list(new AbortController().signal)).rejects.toThrow(
      `Cannot inventory worktrees for owner/app: ${stderr || 'Git listing failed.'}`,
    );
  });

  it.each(['inspection timed out', ''])('reports session inspection failures to cancellable scans: %s', async (stderr) => {
    const path = '/repos/.ai-worktrees/app-session-1';
    const { service } = harness({
      directories: [path],
      run: async (args) => args[0] === 'rev-parse' ? { code: 1, stdout: '', stderr } : ok(),
    });
    await expect(service.list(new AbortController().signal)).rejects.toThrow(
      `Cannot inspect session checkout ${path}: ${stderr || 'Git inspection failed.'}`,
    );
  });

  it('does not start an abandoned inventory', async () => {
    const controller = new AbortController();
    controller.abort(new Error('scan cancelled'));
    const run = vi.fn(async () => ok());
    const { service } = harness({ run });
    await expect(service.list(controller.signal)).rejects.toThrow('scan cancelled');
    expect(run).not.toHaveBeenCalled();
  });

  it('passes the scan cancellation signal to Git and stops between repositories', async () => {
    const controller = new AbortController();
    const run = vi.fn(async (_args: string[], _cwd: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('scan cancelled'));
      return ok();
    });
    const service = createWorktreeService({
      repos: { list: () => [repo(), repo({ id: 'r2' })], get: () => null },
      reviews: { find: () => null }, git: { run },
    });
    await expect(service.list(controller.signal)).rejects.toThrow('scan cancelled');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('propagates a live inventory signal through directory and independent checkout inspection', async () => {
    const signal = new AbortController().signal;
    const path = '/repos/.ai-worktrees/app-session-1';
    const run = vi.fn(async (args: string[], _cwd: string, passed?: AbortSignal) => {
      expect(passed).toBe(signal);
      return ok(args[0] === 'rev-parse' ? '\nmaster\n' : '');
    });
    const listCheckoutDirectories = vi.fn(async (_path: string, passed?: AbortSignal) => {
      expect(passed).toBe(signal);
      return [path];
    });
    const service = createWorktreeService({
      repos: { list: () => [repo()], get: () => null },
      reviews: { find: () => null }, git: { run }, listCheckoutDirectories,
    });
    expect((await service.list(signal)).map((entry) => entry.path)).toEqual([path]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('includes independent session copies, skips invalid paths and does not duplicate linked worktrees', async () => {
    const root = '/repos/.ai-worktrees/';
    const { service } = harness({
      directories: [
        '/unrelated/app-session-outside', `${root}app-pr-7`, `${root}app-session-legacy`,
        ...['master', 'detached', 'missing-branch', 'bad', 'nested'].map((name) => `${root}app-session-${name}`),
      ],
      run: async (args, cwd) => {
        if (args[1] === 'list') return ok(`worktree ${root}app-session-legacy\nHEAD a\nbranch refs/heads/master\n`);
        if (cwd.endsWith('-bad')) return { code: 1, stdout: '', stderr: 'not a checkout' };
        if (cwd.endsWith('-nested')) return ok('nested/\nmaster');
        return ok(`\n${cwd.endsWith('-detached') ? 'HEAD' : cwd.endsWith('-missing-branch') ? '' : 'master'}`);
      },
    });
    expect((await service.list()).map(({ path, branch }) => [path, branch])).toEqual([
      [`${root}app-session-legacy`, 'master'], [`${root}app-pr-7`, null], [`${root}app-session-master`, 'master'],
      [`${root}app-session-detached`, null], [`${root}app-session-missing-branch`, null],
    ]);
  });
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
  it('surfaces non-Error filesystem failures in the cleanup inventory', async () => {
    const { service } = harness({ isBusy: async () => { throw 'Filesystem unavailable'; } });
    await expect(service.remove('/repos/.ai-worktrees/app-pr-7')).rejects.toBe('Filesystem unavailable');
    expect((await service.list())[0].removal).toEqual({ status: 'failed', message: 'Filesystem unavailable' });
  });

  it('exposes feature deletion progress and failures in the same worktree inventory', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const { service } = harness({
      review: { repoId: 'r1', worktreePath: '/repos/.ai-worktrees/app-pr-7' },
      run: async (args) => {
        if (args[1] === 'list') return ok('worktree /repos/.ai-worktrees/app-pr-7\nHEAD a\n');
        if (args[1] === 'remove') { await held; throw new Error('Files locked'); }
        return ok();
      },
    });
    expect(service.pathForFeature?.('f1')).toBe('/repos/.ai-worktrees/app-pr-7');
    const removal = service.removeForFeature('f1');
    const failure = expect(removal).rejects.toThrow('Files locked');
    expect((await service.list())[0].removal?.status).toBe('deleting');
    finish();
    await failure;
    expect((await service.list())[0].removal).toEqual({ status: 'failed', message: 'Files locked' });
  });

  it('keeps leftover PR and task directories visible after Git unregisters them', async () => {
    const { service } = harness({
      directories: ['/repos/.ai-worktrees/app-pr-7', '/repos/.ai-worktrees/app-task-abc',
        '/repos/.ai-worktrees/app-unrelated'],
      run: async () => ok(),
    });
    expect((await service.list()).map((entry) => entry.path)).toEqual([
      '/repos/.ai-worktrees/app-pr-7', '/repos/.ai-worktrees/app-task-abc',
    ]);
    expect(service.pathForFeature?.('missing')).toBeNull();
  });

  it('starts independent removals concurrently, deduplicates a feature removal and keeps listing responsive', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'remove' && args[3].endsWith('pr-7')) await held;
      return ok();
    });
    const { service, removedDirs } = harness({
      run, review: { repoId: 'r1', worktreePath: '/repos/.ai-worktrees/app-pr-7' },
    });
    const first = service.remove('/repos/.ai-worktrees/app-pr-7');
    const duplicate = service.removeForFeature('f1');
    await service.remove('/repos/.ai-worktrees/app-task-2');
    expect(removedDirs).toEqual(['/repos/.ai-worktrees/app-task-2']);
    expect(await service.list()).toEqual([]);
    expect(run.mock.calls.filter(([args]) => args[1] === 'remove')).toHaveLength(2);
    finish();
    await Promise.all([first, duplicate]);
    expect(removedDirs).toHaveLength(2);
  });

  it('bounds concurrent removals and pending admission, releasing slots after errors', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'remove') {
        await held;
        if (args[3].endsWith('-0')) throw new Error('disk unavailable');
      }
      return ok();
    });
    const { service } = harness({ run });
    const jobs = Array.from({ length: 67 }, (_, i) => service.remove(`/repos/.ai-worktrees/app-task-${i}`));
    const outcomes = Promise.allSettled(jobs);
    await vi.waitFor(() => expect(run.mock.calls).toHaveLength(3));
    await expect(service.remove('/repos/.ai-worktrees/app-task-overflow')).rejects.toThrow('queue is full');
    // Duplicate admission remains allowed even when the bounded queue is full.
    const duplicate = service.remove('/repos/.ai-worktrees/app-task-66');
    finish();
    const results = await outcomes;
    await duplicate;
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(run.mock.calls.filter(([args]) => args[1] === 'remove')).toHaveLength(67);
    await service.remove('/repos/.ai-worktrees/app-task-overflow');
  });

  it('rechecks busy state after queue admission and lets other removals continue', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const busy = new Set<string>();
    const { service, removedDirs } = harness({
      isBusy: (path) => busy.has(path),
      run: async (args) => { if (args[1] === 'remove') await held; return ok(); },
    });
    const paths = Array.from({ length: 4 }, (_, i) => `/repos/.ai-worktrees/app-task-${i}`);
    const jobs = paths.map((path) => service.remove(path));
    const outcomes = Promise.allSettled(jobs);
    busy.add(paths[3]);
    finish();
    expect((await outcomes)[3]).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('in use') } });
    expect(removedDirs).toEqual(paths.slice(0, 3));
    busy.clear();
    await service.remove(paths[3]);
    expect(removedDirs).toContain(paths[3]);
  });

  it('protects primary checkouts registered inside another repository’s managed directory', async () => {
    const path = '/repos/.ai-worktrees/app-session-shared';
    const run = vi.fn(async () => ok());
    const { service, removedDirs } = harness({
      repos: [repo(), repo({ id: 'r2', localPath: path })], run,
    });
    await expect(service.remove(path)).rejects.toThrow('primary checkout');
    expect(run).not.toHaveBeenCalled();
    expect(removedDirs).toEqual([]);
  });

  it.each(['locked', ''])('does not delete files after Git refuses a linked checkout: %s', async (stderr) => {
    const { service, removedDirs } = harness({ run: async () => ({ code: 1, stdout: '', stderr }) });
    await expect(service.remove('/repos/.ai-worktrees/app-pr-7')).rejects.toThrow(stderr || 'No files were deleted');
    expect(removedDirs).toEqual([]);
  });

  it('removes an independently cloned session checkout only after verifying its private git directory', async () => {
    const path = '/repos/.ai-worktrees/app-session-1';
    const { service, removedDirs } = harness({
      run: async (args) => args[1] === 'remove'
        ? { code: 1, stdout: '', stderr: 'not a linked worktree' }
        : ok(args[0] === 'rev-parse' ? `\n${path}/.git\n` : ''),
    });
    await service.remove(path);
    expect(removedDirs).toEqual([path]);
  });

  it.each([
    { code: 1, stdout: '', stderr: '' },
    ok('nested/\n/repos/.ai-worktrees/app-session-1/.git'),
    ok('\n'),
    ok('\n/repos/app/.git/worktrees/app-session-1'),
  ])('does not bypass a failed Git removal for an unverified session checkout: %j', async (checkout) => {
    const { service, removedDirs } = harness({
      run: async (args) => args[0] === 'rev-parse' ? checkout : { code: 1, stdout: '', stderr: 'locked or invalid' },
    });
    await expect(service.remove('/repos/.ai-worktrees/app-session-1')).rejects.toThrow('locked or invalid');
    expect(removedDirs).toEqual([]);
  });

  it.each(['prune refused', ''])('reports failed administrative cleanup: %s', async (stderr) => {
    const { service, removedDirs } = harness({
      run: async (args) => args[1] === 'prune' ? { code: 1, stdout: '', stderr } : ok(),
    });
    await expect(service.remove('/repos/.ai-worktrees/app-task-1')).rejects.toThrow(stderr || 'metadata cleanup failed');
    expect(removedDirs).toHaveLength(1);
  });

  it('releases a failed filesystem removal for retry without failing another checkout', async () => {
    const removeDir = vi.fn().mockRejectedValueOnce(new Error('file is locked')).mockResolvedValue(undefined);
    const { service } = harness({ removeDir });
    await expect(service.remove('/repos/.ai-worktrees/app-task-1')).rejects.toThrow('file is locked');
    await Promise.all([
      service.remove('/repos/.ai-worktrees/app-task-1'),
      service.remove('/repos/.ai-worktrees/app-task-2'),
    ]);
    expect(removeDir).toHaveBeenCalledTimes(3);
  });

  it('retries metadata cleanup without repeating an already successful Git removal', async () => {
    let pruneAttempts = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === 'prune' && ++pruneAttempts === 1) return { code: 1, stdout: '', stderr: 'try again' };
      return ok();
    });
    const { service } = harness({ run });
    await expect(service.remove('/repos/.ai-worktrees/app-task-1')).rejects.toThrow('try again');
    await service.remove('/repos/.ai-worktrees/app-task-1');
    expect(run.mock.calls.filter(([args]) => args[1] === 'remove')).toHaveLength(1);
    expect(pruneAttempts).toBe(2);
  });

  it.each(['recreated', 'unavailable'])('revalidates a partially removed checkout before retry: %s', async (mode) => {
    const path = '/repos/.ai-worktrees/app-task-1';
    let first = true;
    const removeDir = vi.fn().mockRejectedValue(new Error('file is locked'));
    const { service } = harness({
      removeDir,
      run: async (args) => {
        if (args[1] === 'list') return mode === 'recreated'
          ? ok(`worktree /repos/app\n\nworktree ${path}\nlocked\n`)
          : { code: 1, stdout: '', stderr: 'unavailable' };
        if (first) { first = false; return ok(); }
        return { code: 1, stdout: '', stderr: 'Git refuses this locked worktree' };
      },
    });
    await expect(service.remove(path)).rejects.toThrow('file is locked');
    await expect(service.remove(path)).rejects.toThrow(mode === 'recreated' ? 'Git refuses' : 'Cannot verify');
    expect(removeDir).toHaveBeenCalledTimes(1);
  });

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
    const base = await mkdtemp(join(process.cwd(), '.wt-svc-test-'));
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
