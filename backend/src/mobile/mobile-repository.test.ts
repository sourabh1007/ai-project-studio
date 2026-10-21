import { describe, expect, it, vi } from 'vitest';
import { importMobileRepository, type MobileRepositoryDeps } from './mobile-repository.js';
import type { Repository } from '../repo/repo-contract.js';

const name = 'owner/repo';
const remoteUrl = `https://github.com/${name}.git`;
function harness() {
  const deps: MobileRepositoryDeps = {
    list: () => [],
    gh: vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ nameWithOwner: name, defaultBranchRef: { name: 'main' } }), stderr: '' })),
    git: vi.fn(async () => ({ code: 0, stdout: remoteUrl, stderr: '' })),
    pathFor: () => 'import-path', pathExists: () => false,
    create: vi.fn((input) => ({ ...input, id: 'repo', createdAt: '' })),
  };
  return { deps, run: (signal = new AbortController().signal) => importMobileRepository(deps, name, signal) };
}
describe('non-destructive mobile repository checkout', () => {
  it('looks up the actual default branch and clones into a host-selected path', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ name, defaultBranch: 'main' });
    expect(h.deps.git).toHaveBeenCalledWith(['clone', '--', remoteUrl, 'import-path'], expect.any(AbortSignal));
    expect(h.deps.create).toHaveBeenCalledWith({ name, remoteUrl, localPath: 'import-path', provider: 'github', defaultBranch: 'main' });
  });
  it('reuses an existing registered checkout without network or destructive Git operations', async () => {
    const h = harness();
    const repo: Repository = { id: 'existing', provider: 'github', name: 'Owner/Repo', remoteUrl, localPath: 'path', defaultBranch: 'master', createdAt: '' };
    h.deps.list = () => [{ ...repo, provider: 'azure-devops' }, repo];
    h.deps.pathExists = () => true;
    expect(await h.run()).toMatchObject({ id: 'existing', defaultBranch: 'master' });
    expect(h.deps.git).not.toHaveBeenCalled();
    expect(h.deps.gh).not.toHaveBeenCalled();
    h.deps.list = () => [{ ...repo, defaultBranch: null }];
    await expect(h.run()).rejects.toThrow('needs repair');
    h.deps.list = () => [repo];
    h.deps.pathExists = () => false;
    await expect(h.run()).rejects.toThrow('needs repair');
  });
  it('recovers a completed clone after a lost response without overwriting files', async () => {
    const h = harness();
    h.deps.pathExists = () => true;
    await h.run();
    expect(vi.mocked(h.deps.git).mock.calls).toHaveLength(2);
    expect(vi.mocked(h.deps.git).mock.calls.some(([args]) => args.includes('clone'))).toBe(false);
    vi.mocked(h.deps.git).mockResolvedValueOnce({ code: 0, stdout: 'other origin', stderr: '' });
    await expect(h.run()).rejects.toThrow('No files were overwritten');
  });
  it('rejects paths and URLs supplied as repository names', async () => {
    const h = harness();
    for (const invalid of ['../repo', 'owner/..', 'https://github.com/owner/repo', 'owner/.', 'path', '-owner/repo']) {
      await expect(importMobileRepository(h.deps, invalid, new AbortController().signal)).rejects.toThrow('owner/repository');
    }
  });
  it.each([null, {}, { nameWithOwner: 1 }, { nameWithOwner: 'other/repo' },
    { nameWithOwner: name }, { nameWithOwner: name, defaultBranchRef: null },
    { nameWithOwner: name, defaultBranchRef: '' }, { nameWithOwner: name, defaultBranchRef: {} },
    { nameWithOwner: name, defaultBranchRef: { name: 1 } },
    { nameWithOwner: name, defaultBranchRef: { name: '' } },
  ])('rejects incomplete, empty or mismatched GitHub metadata', async (metadata) => {
    const h = harness();
    vi.mocked(h.deps.gh).mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(metadata), stderr: '' });
    await expect(h.run()).rejects.toThrow('matching repository');
    expect(h.deps.git).not.toHaveBeenCalled();
  });
  it('reports lookup/clone failures and honours cancellation', async () => {
    for (const stderr of ['lookup failed', '']) {
      const h = harness();
      vi.mocked(h.deps.gh).mockResolvedValueOnce({ code: 1, stdout: '', stderr });
      await expect(h.run()).rejects.toThrow(stderr || 'lookup failed');
    }
    for (const stderr of ['clone failed', '']) {
      const h = harness();
      vi.mocked(h.deps.git).mockResolvedValueOnce({ code: 1, stdout: '', stderr });
      await expect(h.run()).rejects.toThrow(stderr || 'checkout failed');
    }
    const h = harness();
    await expect(h.run(AbortSignal.abort())).rejects.toThrow();
    expect(h.deps.create).not.toHaveBeenCalled();
  });
});
