import { describe, expect, it, vi } from 'vitest';
import { createSharedCheckoutPreparer, detectDefaultBranch, isMissingRef, isNotGitRepository, type GitRunResult } from './shared-session-checkout.js';
import { sessionWorktreeConfigSchema, sessionWorktreeDefaults, SESSION_WORKTREE_NAMESPACE } from './config.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = { repoLocalPath: 'C:\\repo', ref: 'master' };
const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '' });

describe('shared session checkout', () => {
  it('opens existing master without cloning, fetching, creating refs or worktrees', async () => {
    const git = vi.fn(async () => ok('master\n'));
    const prepare = createSharedCheckoutPreparer({ git });
    expect(await prepare(target)).toBe(target.repoLocalPath);
    expect(git.mock.calls).toHaveLength(1);
    expect(git).toHaveBeenCalledWith(['-C', target.repoLocalPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], expect.any(Function));
    expect(SESSION_WORKTREE_NAMESPACE).toBe('sessionWorktree');
    expect(sessionWorktreeConfigSchema.parse(sessionWorktreeDefaults)).toEqual(sessionWorktreeDefaults);
  });
  it('switches to existing master without force, reset or a generated branch', async () => {
    const git = vi.fn(async (args: string[]) => ok(args.includes('symbolic-ref') ? 'other' : ''));
    const report = vi.fn();
    expect(await createSharedCheckoutPreparer({ git, checkoutWorkers: 1 })(target, report)).toBe(target.repoLocalPath);
    expect(git.mock.calls[1][0]).toEqual([
      '-c', 'core.longpaths=true', '-c', 'checkout.workers=1', '-C', target.repoLocalPath,
      'checkout', '--progress', 'master', '--',
    ]);
    expect(report).toHaveBeenLastCalledWith('Switching the shared checkout to master…');
  });
  it('reuses PR checkouts and leaves reopened sessions on their current branch', async () => {
    const git = vi.fn(async () => ok('users/me/pr'));
    const prepare = createSharedCheckoutPreparer({ git });
    const pr = { ...target, ref: 'users/me/pr', checkoutPath: 'C:\\pr' };
    expect(await prepare(pr)).toBe('C:\\pr');
    expect(await prepare(target, undefined, false)).toBe('C:\\repo');
    expect(git).toHaveBeenCalledOnce();
    expect(await prepare(pr, undefined, false)).toBe('C:\\pr');
    expect(git).toHaveBeenCalledTimes(2);
  });
  it('checks a reopened managed checkout without switching its branch and can recover a missing path', async () => {
    const git = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'cannot change to missing path' }));
    const recover = vi.fn(async () => 'C:\\pr');
    const target = { repoLocalPath: 'C:\\repo', ref: 'review', checkoutPath: 'C:\\pr' };
    expect(await createSharedCheckoutPreparer({ git, recover })(target, undefined, false)).toBe('C:\\pr');
    expect(recover).toHaveBeenCalledOnce();
    const detached = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }));
    expect(await createSharedCheckoutPreparer({ git: detached })(target, undefined, false)).toBe('C:\\pr');
    expect(detached).toHaveBeenCalledOnce();
  });
  it('never opens a managed task or PR checkout on an unrelated default when its source ref is missing', async () => {
    const git = vi.fn(async (args: string[]) => args.includes('checkout')
      ? { code: 1, stdout: '', stderr: 'fatal: invalid reference: task' } : ok('other'));
    const target = { repoLocalPath: 'C:\\repo', ref: 'task', checkoutPath: 'C:\\task' };
    await expect(createSharedCheckoutPreparer({ git })(target)).rejects.toThrow('invalid reference');
    expect(git).toHaveBeenCalledTimes(2);
  });
  it('opens the session as-is when the shared checkout is not a Git repository', async () => {
    const git = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }));
    const report = vi.fn();
    const prepare = createSharedCheckoutPreparer({ git });
    expect(await prepare(target, report)).toBe(target.repoLocalPath);
    expect(git).toHaveBeenCalledOnce();
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining('not a Git repository'));
  });
  it('exposes a not-a-git-repository detector', () => {
    expect(isNotGitRepository('fatal: not a git repository (or any of the parent directories): .git')).toBe(true);
    expect(isNotGitRepository('Local changes would be overwritten')).toBe(false);
  });
  it.each([
    'fatal: invalid reference: master',
    "error: pathspec 'master' did not match any file(s) known to git",
  ])('opens on the current branch when the target ref is missing and no default is detectable (%s)', async (stderr) => {
    const git = vi.fn(async (args: string[]) => {
      if (args.includes('refs/remotes/origin/HEAD')) return { code: 128, stdout: '', stderr: '' };
      if (args.includes('symbolic-ref')) return ok('main');
      return { code: 1, stdout: '', stderr };
    });
    const report = vi.fn();
    const prepare = createSharedCheckoutPreparer({ git });
    expect(await prepare(target, report)).toBe(target.repoLocalPath);
    expect(git).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining('opened on the current branch'));
  });
  it('self-heals a missing ref by checking out the detected default branch', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args.includes('refs/remotes/origin/HEAD')) return ok('origin/main\n');
      if (args.includes('symbolic-ref')) return ok('feature\n');
      if (args.includes('main')) return ok('');
      return { code: 1, stdout: '', stderr: 'fatal: invalid reference: master' };
    });
    const report = vi.fn();
    const prepare = createSharedCheckoutPreparer({ git });
    expect(await prepare(target, report)).toBe(target.repoLocalPath);
    expect(git).toHaveBeenCalledWith([
      '-c', 'core.longpaths=true', '-c', `checkout.workers=${sessionWorktreeDefaults.checkoutWorkers}`,
      '-C', target.repoLocalPath, 'checkout', '--progress', 'main', '--',
    ], expect.any(Function));
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("default branch main instead"));
  });
  it('stays on the current branch when the detected default also fails to check out', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args.includes('refs/remotes/origin/HEAD')) return ok('origin/main');
      if (args.includes('symbolic-ref')) return ok('feature');
      return { code: 1, stdout: '', stderr: "error: pathspec 'x' did not match" };
    });
    const report = vi.fn();
    const prepare = createSharedCheckoutPreparer({ git });
    expect(await prepare(target, report)).toBe(target.repoLocalPath);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining('opened on the current branch'));
  });
  it('exposes a default-branch detector that strips the origin prefix and reports absence', async () => {
    const detected = vi.fn(async (args: string[]) =>
      args.includes('refs/remotes/origin/HEAD') ? ok('origin/trunk\n') : ok(''));
    expect(await detectDefaultBranch(detected, 'C:\\repo', () => {})).toBe('trunk');
    expect(await detectDefaultBranch(async () => ({ code: 1, stdout: '', stderr: '' }), 'C:\\repo', () => {})).toBeNull();
    expect(await detectDefaultBranch(async () => ok('   '), 'C:\\repo', () => {})).toBeNull();
  });
  it('detects missing refs across git phrasings', () => {
    expect(isMissingRef('fatal: invalid reference: master')).toBe(true);
    expect(isMissingRef("error: pathspec 'x' did not match")).toBe(true);
    expect(isMissingRef('Local changes would be overwritten')).toBe(false);
  });
  it.each(['Local changes would be overwritten', ''])('surfaces unsafe/failed branch switches without recovery resets (%s)', async (stderr) => {
    const git = vi.fn(async (args: string[]) => args.includes('symbolic-ref')
      ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr });
    const prepare = createSharedCheckoutPreparer({ git });
    await expect(prepare(target)).rejects.toThrow(stderr || 'Cannot switch the shared checkout to master');
    expect(git).toHaveBeenCalledTimes(3);
  });
  it.each([
    { code: 1, stdout: 'unavailable', stderr: 'cannot read index' },
    { code: 0, stdout: '', stderr: '' },
  ])('does not assume unresolved conflicts when the index probe returns $code with "$stdout"', async (index) => {
    const git = vi.fn(async (args: string[]) => args.includes('symbolic-ref') ? ok('feature')
      : args.includes('ls-files') ? index : { code: 1, stdout: '', stderr: 'you need to resolve your current index first' });
    await expect(createSharedCheckoutPreparer({ git })(target)).rejects.toThrow('resolve your current index first');
    expect(git).toHaveBeenLastCalledWith(['-C', target.repoLocalPath, 'ls-files', '--unmerged', '-z'], expect.any(Function));
  });
  it('opens a real conflicted checkout without switching branches or changing the merge, index or local files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-unresolved-index-'));
    const git = vi.fn(async (args: string[]) => {
      const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    });
    const run = async (...args: string[]) => {
      const result = await git(args);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      await run('init', '-b', 'main');
      await run('config', 'user.name', 'Studio fixture');
      await run('config', 'user.email', 'fixture@example.invalid');
      const file = join(root, 'conflict.txt');
      writeFileSync(file, 'base\n');
      await run('add', '--', 'conflict.txt');
      await run('commit', '-m', 'base');
      await run('checkout', '-b', 'feature');
      writeFileSync(file, 'feature\n');
      await run('commit', '-am', 'feature');
      await run('checkout', 'main');
      writeFileSync(file, 'main\n');
      await run('commit', '-am', 'main');
      expect((await git(['merge', 'feature'])).code).toBe(1);
      const before = {
        branch: await run('symbolic-ref', '--short', 'HEAD'),
        head: await run('rev-parse', 'HEAD'),
        index: await run('ls-files', '--stage', '-z'),
        merge: readFileSync(join(root, '.git', 'MERGE_HEAD'), 'utf8'),
        files: readFileSync(file, 'utf8'),
      };
      git.mockClear();
      const report = vi.fn();
      await expect(createSharedCheckoutPreparer({ git })({ repoLocalPath: root, ref: 'feature' }, report)).resolves.toBe(root);
      expect(git.mock.calls.map(([args]) => args.includes('checkout'))).toEqual([false, true, false]);
      expect(report).toHaveBeenLastCalledWith(expect.stringContaining('unresolved merge conflicts'));
      expect({
        branch: await run('symbolic-ref', '--short', 'HEAD'),
        head: await run('rev-parse', 'HEAD'),
        index: await run('ls-files', '--stage', '-z'),
        merge: readFileSync(join(root, '.git', 'MERGE_HEAD'), 'utf8'),
        files: readFileSync(file, 'utf8'),
      }).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps an existing managed checkout without selecting a branch or invoking recovery', async () => {
    const git = vi.fn(async () => ok());
    const recover = vi.fn(async () => null);
    const pathExists = vi.fn(async () => true);
    const report = vi.fn();
    await expect(createSharedCheckoutPreparer({ git, recover, pathExists })(
      { ...target, checkoutPath: 'C:\\pr' }, report,
    )).resolves.toBe('C:\\pr');
    expect(git).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith('Keeping the current managed checkout and its branch.');
  });
  it('recovers a deleted managed checkout rather than skipping it', async () => {
    const git = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'not a git repository' }));
    const recover = vi.fn(async () => 'C:\\pr');
    await expect(createSharedCheckoutPreparer({ git, recover, pathExists: async () => false })(
      { ...target, checkoutPath: 'C:\\pr' },
    )).resolves.toBe('C:\\pr');
    expect(recover).toHaveBeenCalledOnce();
  });
  it('pulls a fresh copy when a branch switch fails and recovery succeeds', async () => {
    const git = vi.fn(async (args: string[]) => args.includes('symbolic-ref')
      ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'corrupt worktree' });
    const recover = vi.fn(async () => 'C:\\fresh');
    const pr = { ...target, checkoutPath: 'C:\\pr' };
    const prepare = createSharedCheckoutPreparer({ git, recover });
    expect(await prepare(pr)).toBe('C:\\fresh');
    expect(recover).toHaveBeenCalledWith({ target: pr, cwd: 'C:\\pr', report: expect.any(Function), confirm: undefined });
  });
  it('forwards consent rather than treating a managed corrupt checkout as usable', async () => {
    const git = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'not a git repository' }));
    const confirm = vi.fn(async () => false);
    const recover = vi.fn(async (input) => {
      expect(await input.confirm('Replace?')).toBe(false);
      throw new Error('Kept current checkout');
    });
    await expect(createSharedCheckoutPreparer({ git, recover })(
      { ...target, checkoutPath: 'C:\\pr' }, undefined, true, confirm,
    )).rejects.toThrow('Kept current checkout');
    expect(confirm).toHaveBeenCalledWith('Replace?');
  });
  it('surfaces the failure when recovery declines (unsaved work or primary clone)', async () => {
    const git = vi.fn(async (args: string[]) => args.includes('symbolic-ref')
      ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'corrupt worktree' });
    const recover = vi.fn(async () => null);
    const prepare = createSharedCheckoutPreparer({ git, recover });
    await expect(prepare(target)).rejects.toThrow('corrupt worktree');
  });
  it('pulls a fresh copy when the shared checkout is not a Git repository and recovery succeeds', async () => {
    const git = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }));
    const recover = vi.fn(async () => 'C:\\fresh');
    const pr = { ...target, checkoutPath: 'C:\\pr' };
    const prepare = createSharedCheckoutPreparer({ git, recover });
    expect(await prepare(pr)).toBe('C:\\fresh');
    expect(recover).toHaveBeenCalledOnce();
  });
  it('opens as-is for a non-recoverable non-Git checkout even with a recovery hook', async () => {
    const git = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }));
    const recover = vi.fn(async () => null);
    const report = vi.fn();
    const prepare = createSharedCheckoutPreparer({ git, recover });
    expect(await prepare(target, report)).toBe(target.repoLocalPath);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining('not a Git repository'));
    await expect(prepare({ ...target, checkoutPath: 'C:\\pr' })).rejects.toThrow('not a git repository');
  });
  it('serializes concurrent opens of one shared checkout and keeps the queue usable after failure', async () => {
    let release!: () => void;
    let calls = 0;
    let active = 0;
    let peak = 0;
    const git = vi.fn(async (_args: string[]) => {
      active++; peak = Math.max(peak, active);
      const index = ++calls;
      if (index === 1) await new Promise<void>((resolve) => { release = resolve; });
      active--;
      if (index === 1) throw new Error('temporary failure');
      return ok('master');
    });
    const prepare = createSharedCheckoutPreparer({ git });
    const first = prepare(target);
    const rejected = expect(first).rejects.toThrow('temporary failure');
    const second = prepare(target);
    expect(git).toHaveBeenCalledOnce();
    release(); await rejected;
    await expect(second).resolves.toBe('C:\\repo');
    await expect(prepare(target)).resolves.toBe('C:\\repo');
    expect(peak).toBe(1);
  });
});
