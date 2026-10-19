import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { createCheckoutRecovery, type CheckoutGitRun } from './checkout-recovery.js';
import type { GitRunResult } from './shared-session-checkout.js';

const ok = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = ''): GitRunResult => ({ code: 1, stdout: '', stderr });
const target = { repoLocalPath: 'C:\\repo', ref: 'review', checkoutPath: 'C:\\review' };
const sha = 'a'.repeat(40);
const metadata = `worktree C:/repo\0HEAD ${'b'.repeat(40)}\0branch refs/heads/master\0\0worktree C:/review\0HEAD ${sha}\0detached\0\0`;

function fixture() {
  const git = vi.fn<CheckoutGitRun>(async (args) => args.includes('list') ? ok(metadata)
    : args.includes('rev-parse') ? ok(sha) : ok());
  const pathExists = vi.fn(async () => false);
  const confirm = vi.fn(async () => true);
  const report = vi.fn();
  const canonicalPath = vi.fn(async (path: string) => path);
  return { git, pathExists, canonicalPath, confirm, report,
    recover: () => createCheckoutRecovery({ git, pathExists, canonicalPath })({ target, cwd: target.checkoutPath, report, confirm }) };
}

describe('automatic checkout recovery', () => {
  it('preserves every existing checkout without inspecting, replacing, or asking about its files', async () => {
    const f = fixture();
    f.pathExists.mockResolvedValue(true);
    await expect(f.recover()).resolves.toBe(target.checkoutPath);
    expect(f.git).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledWith(expect.stringContaining('Keeping the current checkout'));
  });

  it('does not recover an unmanaged primary checkout', async () => {
    const f = fixture();
    await expect(createCheckoutRecovery(f)({
      target: { repoLocalPath: 'C:\\repo', ref: 'master' }, cwd: 'C:\\repo', report: f.report,
    })).resolves.toBeNull();
    expect(f.git).not.toHaveBeenCalled();
  });

  it('refuses to restore over the primary clone, including path casing and separator differences', async () => {
    const f = fixture();
    await expect(createCheckoutRecovery(f)({
      target, cwd: 'c:/REPO/', report: f.report,
    })).rejects.toThrow('primary repository');
    expect(f.git).not.toHaveBeenCalled();
  });

  it('restores the last registered HEAD, not a stale recorded branch, without deleting a worktree', async () => {
    const f = fixture();
    await expect(f.recover()).resolves.toBe(target.checkoutPath);
    expect(f.git).toHaveBeenCalledWith(['-C', 'C:\\repo', 'rev-parse', '--verify', `${sha}^{commit}`], f.report);
    expect(f.git).toHaveBeenCalledWith([
      '-c', 'core.longpaths=true', '-C', 'C:\\repo', 'worktree', 'add', '--detach', '--force', 'C:\\review', sha,
    ], f.report);
    expect(f.git.mock.calls.some(([args]) => args.includes('remove') || args.includes('reset'))).toBe(false);
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it.each(['', 'worktree C:/review\0branch refs/heads/review\0\0', `worktree C:/elsewhere\0HEAD ${sha}\0\0`])(
    'uses the recorded ref when no matching saved HEAD is available (%s)', async (listing) => {
      const f = fixture();
      f.git.mockImplementation(async (args) => args.includes('list') ? ok(listing) : args.includes('rev-parse') ? ok(sha) : ok());
      await f.recover();
      expect(f.git).toHaveBeenCalledWith(['-C', 'C:\\repo', 'rev-parse', '--verify', 'review^{commit}'], f.report);
    },
  );

  it('tries the recorded ref when the saved object no longer exists', async () => {
    const f = fixture();
    f.git.mockImplementation(async (args) => args.includes('list') ? ok(metadata)
      : args.includes(`${sha}^{commit}`) ? bad('missing object') : args.includes('rev-parse') ? ok(sha) : ok());
    await f.recover();
    expect(f.git).toHaveBeenCalledWith(['-C', 'C:\\repo', 'rev-parse', '--verify', 'review^{commit}'], f.report);
  });

  it('ignores empty local commit output rather than provisioning an unknown state', async () => {
    const f = fixture();
    f.git.mockImplementation(async (args) => args.includes('list') ? ok(metadata)
      : args.includes(`${sha}^{commit}`) ? ok(' ') : args.includes('rev-parse') ? ok(sha) : ok());
    await f.recover();
    expect(f.git).toHaveBeenLastCalledWith(expect.arrayContaining(['add', target.checkoutPath, sha]), f.report);
  });

  it('matches POSIX paths without treating path casing as interchangeable', async () => {
    const f = fixture();
    f.git.mockImplementation(async (args) => args.includes('list') ? ok(`worktree /repo/review\0HEAD ${sha}\0\0`)
      : args.includes('rev-parse') ? ok(sha) : ok());
    await expect(createCheckoutRecovery(f)({
      target: { repoLocalPath: '/repo/primary', checkoutPath: '/repo/review', ref: 'review' },
      cwd: '/repo/review', report: f.report,
    })).resolves.toBe('/repo/review');
  });

  it.each([true, false])('fetches the original ref, then master only if necessary (original available=%s)', async (available) => {
    const f = fixture();
    f.git.mockImplementation(async (args) => {
      if (args.includes('list')) return ok('');
      if (args.includes('FETCH_HEAD^{commit}')) return ok(sha);
      if (args.includes('rev-parse')) return bad('missing');
      if (args.includes('fetch') && args.at(-1) === 'review' && !available) return bad('remote ref missing');
      return ok();
    });
    await f.recover();
    expect(f.git).toHaveBeenCalledWith(['-C', 'C:\\repo', 'fetch', 'origin', 'review'], f.report);
    expect(f.git.mock.calls.some(([args]) => args.includes('fetch') && args.at(-1) === 'master')).toBe(!available);
    expect(f.git).toHaveBeenLastCalledWith(expect.arrayContaining(['add', '--detach', '--force', target.checkoutPath, sha]), f.report);
  });

  it('does not fetch master twice when it was already the recorded ref', async () => {
    const f = fixture();
    f.git.mockImplementation(async (args) => args.includes('list') ? ok('')
      : args.includes('FETCH_HEAD^{commit}') ? ok(sha) : args.includes('rev-parse') ? bad() : ok());
    await createCheckoutRecovery(f)({ target: { ...target, ref: 'master' }, cwd: target.checkoutPath, report: f.report });
    expect(f.git.mock.calls.filter(([args]) => args.includes('fetch'))).toHaveLength(1);
  });

  it.each(['Git metadata unavailable', ''])('surfaces unreadable metadata without changing files (%s)', async (error) => {
    const f = fixture();
    f.git.mockResolvedValue(bad(error));
    await expect(f.recover()).rejects.toThrow(error || 'Cannot read the saved worktree state');
    expect(f.git).toHaveBeenCalledOnce();
  });

  it.each(['Remote unavailable', ''])('surfaces master fetch failures (%s)', async (error) => {
    const f = fixture();
    f.git.mockImplementation(async (args) => args.includes('list') ? ok('') : bad(error));
    await expect(f.recover()).rejects.toThrow(error || 'Could not fetch master');
    expect(f.git.mock.calls.some(([args]) => args.includes('add'))).toBe(false);
  });

  it.each(['Invalid fetched commit', '', 'empty-output'])('surfaces fetched commit resolution failures (%s)', async (error) => {
    const f = fixture();
    f.git.mockImplementation(async (args) => {
      if (args.includes('FETCH_HEAD^{commit}')) return error === 'empty-output' ? ok('  ') : bad(error);
      return args.includes('rev-parse') ? bad() : ok();
    });
    await expect(f.recover()).rejects.toThrow(error && error !== 'empty-output' ? error : 'Could not resolve the fetched review commit');
  });

  it('preserves a checkout recreated while recovery was resolving its commit', async () => {
    const f = fixture();
    f.pathExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await f.recover();
    expect(f.git.mock.calls.some(([args]) => args.includes('add'))).toBe(false);
    expect(f.report).toHaveBeenLastCalledWith(expect.stringContaining('keeping its current files'));
  });

  it.each(['worktree is locked', ''])('surfaces add failures without unlocking or removing anything (%s)', async (error) => {
    const f = fixture();
    f.git.mockImplementation(async (args) => args.includes('list') ? ok(metadata)
      : args.includes('rev-parse') ? ok(sha) : bad(error));
    await expect(f.recover()).rejects.toThrow(error || 'Existing checkouts were not replaced');
  });

  it('does not treat filesystem permission errors as a missing checkout', async () => {
    const f = fixture();
    f.pathExists.mockRejectedValue(new Error('Access denied'));
    await expect(f.recover()).rejects.toThrow('Access denied');
    expect(f.git).not.toHaveBeenCalled();
  });

  it('preserves dirty files and recovers deleted branch and detached worktrees with real Git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-keep-checkout-'));
    const primary = join(root, 'primary');
    const checkout = join(root, 'review');
    mkdirSync(primary);
    const run = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const git: CheckoutGitRun = async (args) => {
      try { return ok(run(args)); } catch (error) {
        if (!(error instanceof Error) || !('stderr' in error)) throw error;
        return bad(String(error.stderr));
      }
    };
    const recover = createCheckoutRecovery({
      git, pathExists: async (path) => existsSync(path),
      canonicalPath: async (path) => join(realpathSync.native(dirname(path)), basename(path)),
    });
    const input = { target: { repoLocalPath: primary, checkoutPath: checkout, ref: 'review' }, cwd: checkout, report: vi.fn() };
    try {
      run(['init', '--initial-branch=master', primary]);
      writeFileSync(join(primary, 'tracked.txt'), 'original');
      run(['-C', primary, 'add', '.']);
      run(['-C', primary, '-c', 'user.name=Studio test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
      run(['-C', primary, 'worktree', 'add', '-b', 'review', checkout, 'master']);
      writeFileSync(join(checkout, 'tracked.txt'), 'local committed state');
      run(['-C', checkout, 'add', '.']);
      run(['-C', checkout, '-c', 'user.name=Studio test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'local work']);
      const branchHead = run(['-C', checkout, 'rev-parse', 'HEAD']);
      writeFileSync(join(checkout, 'local.txt'), 'must stay');
      await recover(input);
      expect(readFileSync(join(checkout, 'local.txt'), 'utf8')).toBe('must stay');
      rmSync(checkout, { recursive: true, force: true });
      await recover(input);
      expect(run(['-C', checkout, 'rev-parse', 'HEAD'])).toBe(branchHead);
      expect(readFileSync(join(checkout, 'tracked.txt'), 'utf8')).toBe('local committed state');
      writeFileSync(join(checkout, 'tracked.txt'), 'detached committed state');
      run(['-C', checkout, 'add', '.']);
      run(['-C', checkout, '-c', 'user.name=Studio test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'detached work']);
      const detachedHead = run(['-C', checkout, 'rev-parse', 'HEAD']);
      rmSync(checkout, { recursive: true, force: true });
      await recover(input);
      expect(run(['-C', checkout, 'rev-parse', 'HEAD'])).toBe(detachedHead);
      expect(run(['-C', primary, 'branch', '--show-current'])).toBe('master');
      expect(readFileSync(join(primary, 'tracked.txt'), 'utf8')).toBe('original');
      run(['-C', primary, 'remote', 'add', 'origin', primary]);
      const fallback = join(root, 'fallback');
      await recover({ target: { repoLocalPath: primary, checkoutPath: fallback, ref: 'deleted-branch' }, cwd: fallback, report: input.report });
      expect(run(['-C', fallback, 'rev-parse', 'HEAD'])).toBe(run(['-C', primary, 'rev-parse', 'master']));
      expect(readFileSync(join(fallback, 'tracked.txt'), 'utf8')).toBe('original');
      expect(input.report).toHaveBeenCalledWith('Fetching master to restore the managed worktree…');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
