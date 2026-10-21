import { describe, expect, it, vi } from 'vitest';
import { createMobilePublication, type MobilePublicationDeps } from './mobile-publication.js';
import type { MobileApproval, MobileChatRecord } from './mobile-contract.js';
import type { NewTaskRun } from '../new-task/new-task-contract.js';

const head = 'a'.repeat(40);
const chat = { attachmentId: 'a', repoId: 'repo' } as MobileChatRecord;
const approval: MobileApproval = {
  id: 'approval', repoId: 'repo', remoteUrl: 'https://github.com/owner/repo.git',
  head, branch: 'users/dev/task', baseBranch: 'main', title: 'Approved title', body: 'Approved body', expiresAt: '',
};
function harness() {
  const deps: MobilePublicationDeps = {
    git: vi.fn(async (args) => {
      if (args.includes('status')) return { code: 0, stdout: '', stderr: '' };
      if (args.includes('symbolic-ref')) return { code: 0, stdout: approval.branch, stderr: '' };
      if (args.includes('rev-parse')) return { code: 0, stdout: head, stderr: '' };
      if (args.includes('get-url')) return { code: 0, stdout: approval.remoteUrl, stderr: '' };
      if (args.includes('ls-remote')) return { code: 0, stdout: `${head}\trefs/heads/${approval.branch}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }),
    gh: vi.fn(async (args) => ({
      code: 0, stdout: args[1] === 'list' ? '[]' : args[1] === 'view' ? head : 'https://github.com/owner/repo/pull/1', stderr: '',
    })),
    resolve: () => ({ worktreePath: 'worktree', baseBranch: 'main', branch: approval.branch, repoName: 'owner/repo', remoteUrl: approval.remoteUrl }),
    getRun: () => ({ id: 'a', title: 'Title' }) as NewTaskRun,
    saveRun: vi.fn(), now: () => '2026-01-01T00:00:00Z',
    makeEligible: vi.fn(async () => 'review'),
  };
  return { deps, publisher: createMobilePublication(deps) };
}
const signal = () => new AbortController().signal;

describe('exact-revision mobile publication', () => {
  it('pins the exact approved commit and destination, preserving Git hooks, creating only a draft PR', async () => {
    const h = harness();
    expect(await h.publisher.revision(chat)).toMatchObject({ head, branch: approval.branch });
    const run = await h.publisher.publish(chat, approval, signal());
    expect(h.deps.git).toHaveBeenCalledWith(['-C', 'worktree', 'push', '--', approval.remoteUrl, `${head}:refs/heads/${approval.branch}`], expect.any(AbortSignal));
    expect(h.deps.gh).toHaveBeenCalledWith(['pr', 'create', '--draft', '--repo', 'owner/repo',
      '--head', approval.branch, '--base', 'main', '--title', approval.title, '--body', approval.body]);
    expect(run).toMatchObject({ status: 'pr-created', prNumber: 1, reviewFeatureId: 'review' });
    expect(h.deps.saveRun).toHaveBeenCalledWith(run);
  });
  it('recovers an already-created PR without creating duplicates after a partial failure', async () => {
    const h = harness();
    vi.mocked(h.deps.gh).mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([
      { number: 2, url: 'https://github.com/owner/repo/pull/2', headRefOid: head, state: 'CLOSED' },
      { number: 1, url: 'https://github.com/owner/repo/pull/1', headRefOid: head, state: 'OPEN' },
    ]), stderr: '' });
    await h.publisher.publish(chat, approval, signal());
    expect(vi.mocked(h.deps.gh).mock.calls.some(([args]) => args[1] === 'create')).toBe(false);
  });
  it.each([
    ['status', '?? uncommitted', 'uncommitted'],
    ['symbolic-ref', 'other-branch', 'branch changed'],
    ['rev-parse', 'not-a-sha', 'valid commit'],
    ['get-url', 'https://github.com/other/repo.git', 'destination differs'],
  ])('rejects unsafe %s state', async (command, stdout, message) => {
    const h = harness();
    const original = h.deps.git;
    h.deps.git = async (args) => args.includes(command) ? { code: 0, stdout, stderr: '' } : original(args);
    await expect(h.publisher.revision(chat)).rejects.toThrow(message);
  });
  it('rejects unsafe repository identities and credential-bearing remotes', async () => {
    for (const patch of [{ repoName: 'bad' }, { remoteUrl: 'https://token@github.com/owner/repo.git' }]) {
      const h = harness();
      const scope = h.deps.resolve(chat);
      h.deps.resolve = () => ({ ...scope, ...patch });
      await expect(h.publisher.revision(chat)).rejects.toThrow('canonical');
    }
  });
  it.each(['head', 'branch', 'baseBranch', 'remoteUrl', 'repoId'] as const)('rejects stale approval %s', async (key) => {
    const h = harness();
    await expect(h.publisher.publish(chat, { ...approval, [key]: 'changed' }, signal())).rejects.toThrow('stale');
    expect(vi.mocked(h.deps.git).mock.calls.some(([args]) => args.includes('push'))).toBe(false);
  });
  it('does not publish when cancelled before push', async () => {
    const h = harness();
    await expect(h.publisher.publish(chat, approval, AbortSignal.abort())).rejects.toThrow();
    expect(vi.mocked(h.deps.git).mock.calls.some(([args]) => args.includes('push'))).toBe(false);
  });
  it('reports Git and GitHub command failures without success-shaped defaults', async () => {
    for (const stderr of ['Git failed', '']) {
      const h = harness();
      vi.mocked(h.deps.git).mockResolvedValueOnce({ code: 1, stdout: '', stderr });
      await expect(h.publisher.revision(chat)).rejects.toThrow(stderr || 'Git operation failed');
    }
    for (const stderr of ['Not authenticated', '']) {
      const h = harness();
      vi.mocked(h.deps.gh).mockResolvedValueOnce({ code: 1, stdout: '', stderr });
      await expect(h.publisher.publish(chat, approval, signal())).rejects.toThrow(stderr || 'GitHub publication failed');
    }
  });
  it.each([
    ['{}', 'invalid pull-request list'],
    [JSON.stringify([{ number: 1, url: 'https://github.com/owner/repo/pull/1', headRefOid: 'b'.repeat(40), state: 'OPEN' }]), 'different revision'],
    [JSON.stringify([{ number: 1, url: 'https://github.com/other/repo/pull/1', headRefOid: head, state: 'OPEN' }]), 'different repository'],
  ])('rejects invalid or unrelated existing PRs', async (stdout, error) => {
    const h = harness();
    vi.mocked(h.deps.gh).mockResolvedValueOnce({ code: 0, stdout, stderr: '' });
    await expect(h.publisher.publish(chat, approval, signal())).rejects.toThrow(error);
  });
  it('reports a malformed create response and a moved PR head', async () => {
    const invalid = harness();
    vi.mocked(invalid.deps.gh)
      .mockResolvedValueOnce({ code: 0, stdout: '[]', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'not a PR URL', stderr: '' });
    await expect(invalid.publisher.publish(chat, approval, signal())).rejects.toThrow('valid draft');
    const moved = harness();
    const original = moved.deps.gh;
    moved.deps.gh = async (args) => args[1] === 'view' ? { code: 0, stdout: 'other-sha', stderr: '' } : original(args);
    await expect(moved.publisher.publish(chat, approval, signal())).rejects.toThrow('head changed');
    const remote = harness();
    const git = remote.deps.git;
    remote.deps.git = async (args) => args.includes('ls-remote') ? { code: 0, stdout: '', stderr: '' } : git(args);
    await expect(remote.publisher.publish(chat, approval, signal())).rejects.toThrow('remote branch changed');
  });
});
