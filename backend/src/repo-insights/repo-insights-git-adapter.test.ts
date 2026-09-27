import { describe, expect, it, vi } from 'vitest';
import { createRepoInsightsGitAdapter, type GitCommandExecutor } from './repo-insights-git-adapter.js';

describe('repository scan Git cancellation and deadlines', () => {
  it('forwards cancellation and the configured deadline for every operation', async () => {
    const run = vi.fn<GitCommandExecutor['run']>().mockResolvedValue({ stdout: 'origin/main\n' });
    const git = createRepoInsightsGitAdapter({ run }, 123);
    const signal = new AbortController().signal;
    await git.resolveDefaultBranch('repo', signal);
    await git.listFiles('repo', 'main', 'docs', true, signal);
    await git.readFile('repo', 'main', 'docs/a.md', signal);
    await git.fileExists('repo', 'main', 'AGENTS.md', signal);
    await git.lastCommitAuthor('repo', 'main', 'docs/a.md', signal);
    expect(run).toHaveBeenCalledTimes(5);
    for (const call of run.mock.calls) {
      expect(call[2]).toEqual({ signal, timeout: 123 });
    }
  });

  it('cancels a running command rather than reporting an empty result', async () => {
    const controller = new AbortController();
    const run: GitCommandExecutor['run'] = (_exe, _args, { signal }) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
    const git = createRepoInsightsGitAdapter({ run });
    const pending = git.readFile('repo', 'main', 'docs/a.md', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('reports timed-out Git commands while preserving missing-file behavior', async () => {
    const run = vi.fn<GitCommandExecutor['run']>()
      .mockRejectedValueOnce(Object.assign(new Error('killed'), { killed: true }))
      .mockRejectedValueOnce(new Error('missing path'));
    const git = createRepoInsightsGitAdapter({ run }, 123);
    await expect(git.listFiles('repo', 'main', 'docs')).rejects.toThrow('exceeded 123ms');
    expect(await git.readFile('repo', 'main', 'missing')).toBeNull();
  });
});
