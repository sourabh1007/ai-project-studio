import { describe, expect, it, vi } from 'vitest';
import { createSharedCheckoutPreparer, isMissingRef, isNotGitRepository, type GitRunResult } from './shared-session-checkout.js';
import { sessionWorktreeConfigSchema, sessionWorktreeDefaults, SESSION_WORKTREE_NAMESPACE } from './config.js';

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
  ])('opens on the current branch when the target ref is missing (%s)', async (stderr) => {
    const git = vi.fn(async (args: string[]) => args.includes('symbolic-ref')
      ? ok('main') : { code: 1, stdout: '', stderr });
    const report = vi.fn();
    const prepare = createSharedCheckoutPreparer({ git });
    expect(await prepare(target, report)).toBe(target.repoLocalPath);
    expect(git).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining('was not found'));
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
    expect(git).toHaveBeenCalledTimes(2);
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
