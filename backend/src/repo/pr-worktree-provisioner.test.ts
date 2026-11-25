import { describe, it, expect, vi } from 'vitest';
import { join, dirname, basename } from 'node:path';
import {
  provisionPrWorktree,
  prWorktreePath,
  describeWorktreeFailure,
  describeFetchFailure,
  checkedOutWorktreePath,
  type GitRunResult,
  type ProvisionStatus,
} from './pr-worktree-provisioner.js';

const ok: GitRunResult = { code: 0, stdout: '', stderr: '' };

function gitRecorder(results: GitRunResult[]) {
  const calls: string[][] = [];
  let i = 0;
  const git = (args: string[]): Promise<GitRunResult> => {
    calls.push(args);
    if (args.includes('--show-prefix')) {
      return Promise.resolve({ ...ok, stdout: 'true\n\n' });
    }
    if (args.includes('status')) return Promise.resolve(ok);
    if (args.includes('show-ref')) return Promise.resolve({ ...ok, code: 1 });
    return Promise.resolve(results[i++] ?? ok);
  };
  return { git, calls };
}

const repoLocalPath = join('C:', 'work', 'app');

describe('prWorktreePath', () => {
  it('places the worktree in a sibling .ai-worktrees directory', () => {
    expect(prWorktreePath(repoLocalPath, 12)).toBe(
      join(dirname(repoLocalPath), '.ai-worktrees', `${basename(repoLocalPath)}-pr-12`),
    );
  });
});

describe('provisionPrWorktree', () => {
  it.each(['missing metadata', 'local edits'])('preserves an existing checkout with %s and creates a separate review worktree', async (reason) => {
    const original = prWorktreePath(repoLocalPath, 12);
    const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok]);
    const git = async (args: string[]): Promise<GitRunResult> => {
      if (args.includes('--show-prefix') && args[1] === original && reason === 'missing metadata') {
        recorder.calls.push(args);
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
      }
      if (args.includes('status') && args[1] === original && reason === 'local edits') {
        recorder.calls.push(args);
        return { ...ok, stdout: ' M file.ts\0?? notes.txt\0' };
      }
      return recorder.git(args);
    };
    const statuses: ProvisionStatus[] = [];
    const result = await provisionPrWorktree({ git, pathExists: (path) => path === original },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' }, (status) => statuses.push(status));
    expect(result.worktreePath).not.toBe(original);
    expect(result).toMatchObject({ headSha: 'abc123', tracksPullRequest: false });
    expect(recorder.calls.some((args) => args.includes('checkout') && args.includes(original))).toBe(false);
    const add = recorder.calls.find((args) => args.includes('worktree') && args.includes('add'))!;
    expect(add).toContain('-b');
    expect(add).not.toContain('--force');
    expect(add).not.toContain('-B');
    expect(statuses.some((status) => /preserv|keeping/i.test(status.message))).toBe(true);
  });

  it('explains a missing primary Git repository as a local checkout problem instead of a provider failure', async () => {
    const { git } = gitRecorder([{ code: 128, stdout: '', stderr: 'fatal: not a git repository' }]);
    await expect(provisionPrWorktree({ git, pathExists: () => true },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' }))
      .rejects.toThrow(/local repository.*Settings/i);
  });

  it.each(['parent repository', 'empty root', 'unreadable status'])('does not reset a checkout with %s', async (scenario) => {
    const original = prWorktreePath(repoLocalPath, 12);
    const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok]);
    const git = async (args: string[]): Promise<GitRunResult> => {
      if (args.includes('--show-prefix') && scenario !== 'unreadable status') {
        recorder.calls.push(args);
        return { ...ok, stdout: scenario === 'empty root' ? '' : 'true\nparent-subdirectory/\n' };
      }
      if (args.includes('status')) {
        recorder.calls.push(args);
        return { ...ok, code: 128, stderr: 'Cannot inspect the existing checkout' };
      }
      return recorder.git(args);
    };
    const result = await provisionPrWorktree({ git, pathExists: (path) => path === original },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' });
    expect(result.worktreePath).not.toBe(original);
    expect(recorder.calls.some((args) => args.includes('checkout'))).toBe(false);
  });

  it.each(['bad head', 'different head', 'detached', 'different branch', 'invalid metadata'])(
    'preserves an occupied recovery checkout with %s', async (scenario) => {
      const original = prWorktreePath(repoLocalPath, 12);
      const occupied = join(dirname(original), `${basename(repoLocalPath)}-pr-r12-abc123-1`);
      const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok]);
      const git = async (args: string[]): Promise<GitRunResult> => {
        if (args.includes('--show-prefix') && (args[1] === original || scenario === 'invalid metadata')) {
          recorder.calls.push(args);
          return { ...ok, code: 128, stderr: 'not a git repository' };
        }
        if (args[1] === occupied && args.at(-1) === 'HEAD' && args.includes('rev-parse')) {
          recorder.calls.push(args);
          return { ...ok, code: scenario === 'bad head' ? 128 : 0,
            stdout: scenario === 'different head' ? 'other-commit' : 'abc123' };
        }
        if (args.includes('symbolic-ref')) {
          recorder.calls.push(args);
          return { ...ok, code: scenario === 'detached' ? 1 : 0, stdout: 'user-branch' };
        }
        return recorder.git(args);
      };
      const result = await provisionPrWorktree({ git, pathExists: (path) => path === original || path === occupied },
        { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' });
      expect(result.worktreePath).not.toBe(occupied);
      expect(recorder.calls.some((args) => args.includes('checkout'))).toBe(false);
    },
  );

  it('skips existing branches and a concurrently claimed recovery destination without forcing either', async () => {
    const original = prWorktreePath(repoLocalPath, 12);
    const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok]);
    let branches = 0;
    let adds = 0;
    const git = async (args: string[]): Promise<GitRunResult> => {
      if (args.includes('--show-prefix')) {
        recorder.calls.push(args); return { ...ok, code: 128 };
      }
      if (args.includes('show-ref')) {
        recorder.calls.push(args); return { ...ok, code: ++branches === 1 ? 0 : 1 };
      }
      if (args.includes('add') && ++adds === 1) {
        recorder.calls.push(args); return { ...ok, code: 128, stderr: 'a branch already exists' };
      }
      return recorder.git(args);
    };
    const result = await provisionPrWorktree({ git, pathExists: (path) => path === original },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' });
    expect(result.worktreePath).toMatch(/-3$/);
    expect(recorder.calls.flat()).not.toContain('--force');
    expect(recorder.calls.flat()).not.toContain('-B');
  });

  it.each(['permission denied', ''])('surfaces a failed replacement checkout while preserving original files: %j', async (stderr) => {
    const original = prWorktreePath(repoLocalPath, 12);
    const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok]);
    const git = async (args: string[]): Promise<GitRunResult> => {
      if (args.includes('--show-prefix') || args.includes('add')) {
        return { ...ok, code: 128, stderr };
      }
      return recorder.git(args);
    };
    await expect(provisionPrWorktree({ git, pathExists: (path) => path === original },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' }))
      .rejects.toThrow(stderr || 'Existing files were preserved');
  });

  it('does not create a worktree when the recovery branch cannot be inspected', async () => {
    const original = prWorktreePath(repoLocalPath, 12);
    const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok]);
    const git = async (args: string[]): Promise<GitRunResult> => {
      if (args.includes('--show-prefix') || args.includes('show-ref')) {
        recorder.calls.push(args);
        return { ...ok, code: 128, stderr: 'not a git repository' };
      }
      return recorder.git(args);
    };
    await expect(provisionPrWorktree({ git, pathExists: (path) => path === original },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' }))
      .rejects.toThrow('Could not verify a safe recovery branch');
    expect(recorder.calls.some((args) => args.includes('add'))).toBe(false);
  });

  it('bounds recovery attempts instead of deleting occupied checkouts', async () => {
    const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok]);
    const git = async (args: string[]): Promise<GitRunResult> => {
      if (args.includes('--show-prefix')) {
        recorder.calls.push(args); return { ...ok, code: 128 };
      }
      return recorder.git(args);
    };
    await expect(provisionPrWorktree({ git, pathExists: () => true },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' }))
      .rejects.toThrow('No unused recovery checkout');
    expect(recorder.calls.some((args) => args.includes('add') || args.includes('remove') || args.includes('prune'))).toBe(false);
  });

  it('recovers when Git metadata disappears between verification and checkout', async () => {
    const original = prWorktreePath(repoLocalPath, 12);
    const recorder = gitRecorder([ok, { ...ok, stdout: 'abc123' }, ok,
      { code: 128, stdout: '', stderr: 'fatal: not a git repository' }]);
    const result = await provisionPrWorktree({ git: recorder.git, pathExists: (path) => path === original },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'topic' });
    expect(result.worktreePath).not.toBe(original);
    expect(result.headSha).toBe('abc123');
  });

  it('keeps concurrent PR fetches isolated before checking out their exact commits', async () => {
    const refs = new Map<string, string>();
    const calls: string[][] = [];
    let release!: () => void;
    const bothFetched = new Promise<void>((resolve) => { release = resolve; });
    let fetches = 0;
    const git = async (args: string[]): Promise<GitRunResult> => {
      calls.push(args);
      if (args.includes('fetch')) {
        expect(args).toContain('--no-write-fetch-head');
        expect(args).toContain('--no-auto-maintenance');
        const [source, target] = args.at(-1)!.split(':');
        refs.set(target, source.includes('/12/') ? 'sha12' : 'sha13');
        if (++fetches === 2) release();
        await bothFetched;
        return ok;
      }
      if (args.includes('rev-parse')) {
        return { ...ok, stdout: refs.get(args.at(-1)!)! };
      }
      return ok;
    };
    const results = await Promise.all([12, 13].map((number) =>
      provisionPrWorktree({ git, pathExists: () => false }, {
        repoLocalPath, provider: 'github', number, sourceBranch: '',
      }),
    ));
    expect(results.map((result) => result.headSha)).toEqual(['sha12', 'sha13']);
    const adds = calls.filter((args) => args.includes('worktree'));
    expect(adds[0].slice(-2)).toEqual([prWorktreePath(repoLocalPath, 12), 'sha12']);
    expect(adds[1].slice(-2)).toEqual([prWorktreePath(repoLocalPath, 13), 'sha13']);
    expect(calls.flat()).not.toContain('FETCH_HEAD');
  });

  it('checks out the GitHub PR head branch tracking origin and adds a forced worktree', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'abc123\n', stderr: '' }]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'feature-x' },
    );
    const worktreePath = prWorktreePath(repoLocalPath, 12);
    expect(result).toEqual({
      worktreePath,
      branch: 'feature-x',
      tracksPullRequest: true,
      headSha: 'abc123',
    });
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      '+pull/12/head:refs/ai-project-studio/pr/12',
    ]);
    expect(calls[1]).toEqual(['-C', repoLocalPath, 'rev-parse', 'refs/ai-project-studio/pr/12']);
    expect(calls[2]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      '+feature-x:refs/remotes/origin/feature-x',
    ]);
    expect(calls[3]).toEqual([
      '-c',
      'core.longpaths=true',
      '-c',
      'checkout.workers=0',
      '-C',
      repoLocalPath,
      'worktree',
      'add',
      '--force',
      '-B',
      'feature-x',
      worktreePath,
      'abc123',
    ]);
    expect(calls[4]).toEqual([
      '-C',
      worktreePath,
      'branch',
      '--set-upstream-to=origin/feature-x',
      'feature-x',
    ]);
  });

  it('falls back to a detached pr-<n> branch when the head branch is not on origin (fork PR)', async () => {
    const { git, calls } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc123\n', stderr: '' },
      { code: 1, stdout: '', stderr: "couldn't find remote ref feature-x" },
    ]);
    const worktreePath = prWorktreePath(repoLocalPath, 12);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 12, sourceBranch: 'feature-x' },
    );
    expect(result).toEqual({
      worktreePath,
      branch: 'pr-12',
      tracksPullRequest: false,
      headSha: 'abc123',
    });
    expect(calls[3][calls[3].length - 2]).toBe(worktreePath);
    expect(calls[3]).toContain('pr-12');
    // No upstream is set for a fork fallback.
    expect(calls).toHaveLength(4);
  });

  it('does not attempt tracking when the source branch is unknown', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'abc\n', stderr: '' }]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 9, sourceBranch: '' },
    );
    expect(result.branch).toBe('pr-9');
    expect(result.tracksPullRequest).toBe(false);
    // fetch head, rev-parse, worktree add — no track fetch, no set-upstream.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain('worktree');
  });

  it('checks out the Azure source branch tracking origin', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'abc123\n', stderr: '' }]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      {
        repoLocalPath,
        provider: 'azure-devops',
        number: 7,
        sourceBranch: 'topic/x',
      },
    );
    expect(result.branch).toBe('topic/x');
    expect(result.tracksPullRequest).toBe(true);
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      '+topic/x:refs/ai-project-studio/pr/7',
    ]);
    expect(calls[2]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      '+topic/x:refs/remotes/origin/topic/x',
    ]);
  });

  it('falls back to the PR merge ref then a detached branch when the Azure source branch is not resolvable', async () => {
    const { git, calls } = gitRecorder([
      { code: 1, stdout: '', stderr: "fatal: couldn't find remote ref topic/x" },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: 'sha789\n', stderr: '' },
      { code: 1, stdout: '', stderr: 'no branch' },
    ]);
    const worktreePath = prWorktreePath(repoLocalPath, 7);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
    );
    expect(result).toEqual({
      worktreePath,
      branch: 'pr-7',
      tracksPullRequest: false,
      headSha: 'sha789',
    });
    expect(calls[0]).toEqual(['-C', repoLocalPath, 'fetch', '--no-write-fetch-head', '--no-auto-maintenance', 'origin', '+topic/x:refs/ai-project-studio/pr/7']);
    expect(calls[1]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      '+refs/pull/7/merge:refs/ai-project-studio/pr/7',
    ]);
    expect(calls[2]).toEqual(['-C', repoLocalPath, 'rev-parse', 'refs/ai-project-studio/pr/7']);
    expect(calls[3]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      '+topic/x:refs/remotes/origin/topic/x',
    ]);
    expect(calls[4][calls[4].length - 1]).toBe('sha789');
  });

  it('surfaces favourite/publish guidance when no Azure ref can be fetched', async () => {
    const { git } = gitRecorder([
      { code: 1, stdout: '', stderr: "fatal: couldn't find remote ref topic/x" },
      {
        code: 1,
        stdout: '',
        stderr: "fatal: couldn't find remote ref refs/pull/7/merge",
      },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
      ),
    ).rejects.toThrow(/favourite \/ publish it/i);
  });

  it('reuses a verified clean worktree, switching it to the freshly fetched head branch', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'def456\n', stderr: '' }]);
    const worktreePath = prWorktreePath(repoLocalPath, 3);
    const result = await provisionPrWorktree(
      { git, pathExists: () => true },
      { repoLocalPath, provider: 'github', number: 3, sourceBranch: 'feat' },
    );
    expect(result).toEqual({
      worktreePath,
      branch: 'feat',
      tracksPullRequest: true,
      headSha: 'def456',
    });
    expect(calls[0]).toEqual([
      '-C',
      repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      '+pull/3/head:refs/ai-project-studio/pr/3',
    ]);
    expect(calls[1]).toEqual(['-C', repoLocalPath, 'rev-parse', 'refs/ai-project-studio/pr/3']);
    expect(calls.find((args) => args.includes('checkout'))).toEqual([
      '-c',
      'core.longpaths=true',
      '-c',
      'checkout.workers=0',
      '-C',
      worktreePath,
      'checkout',
      '-f',
      '-B',
      'feat',
      'def456',
    ]);
    expect(calls.at(-1)).toEqual([
      '-C',
      worktreePath,
      'branch',
      '--set-upstream-to=origin/feat',
      'feat',
    ]);
  });

  it('throws when the fetch fails', async () => {
    const { git } = gitRecorder([{ code: 1, stdout: '', stderr: 'no ref' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('no ref');
  });

  it('throws a default message when fetch fails without stderr', async () => {
    const { git } = gitRecorder([{ code: 1, stdout: '', stderr: '' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('Failed to fetch pull request #9');
  });

  it('throws when resolving the fetched head fails', async () => {
    const { git } = gitRecorder([ok, { code: 1, stdout: '', stderr: 'bad rev' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('bad rev');
  });

  it('throws a default message when rev-parse fails without stderr', async () => {
    const { git } = gitRecorder([ok, { code: 1, stdout: '', stderr: '' }]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('Failed to resolve the fetched head for pull request #9');
  });

  it('throws when the checkout fails for an existing worktree', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      { code: 1, stdout: '', stderr: 'dirty' },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => true },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('dirty');
  });

  it('throws a default message when the checkout fails without stderr', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      { code: 1, stdout: '', stderr: '' },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => true },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('Failed to update the review worktree');
  });

  it('throws when the worktree add fails', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      { code: 1, stdout: '', stderr: 'busy' },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow('busy');
  });

  it('surfaces a long-path guidance message when the checkout hits MAX_PATH', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'abc\n', stderr: '' },
      ok,
      {
        code: 1,
        stdout: '',
        stderr:
          "error: unable to create file Product/Backend/x: Filename too long",
      },
    ]);
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false },
        { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
      ),
    ).rejects.toThrow(/long paths/i);
  });

  it('reviews in place when worktree add reports the branch is checked out elsewhere', async () => {
    const { git, calls } = gitRecorder([
      ok,
      { code: 0, stdout: 'fetched\n', stderr: '' },
      ok,
      {
        code: 1,
        stdout: '',
        stderr:
          "fatal: cannot force update the branch 'b' used by worktree at 'Q:/src/CosmosDB'",
      },
      { code: 0, stdout: 'local-sha\n', stderr: '' },
    ]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
    );
    expect(result).toEqual({
      worktreePath: 'Q:/src/CosmosDB',
      branch: 'b',
      tracksPullRequest: true,
      headSha: 'local-sha',
    });
    expect(calls[calls.length - 1]).toEqual([
      '-C',
      'Q:/src/CosmosDB',
      'rev-parse',
      'HEAD',
    ]);
  });

  it('reviews in place when the existing-worktree checkout hits the same conflict', async () => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'fetched\n', stderr: '' },
      ok,
      {
        code: 1,
        stdout: '',
        stderr: "cannot force update the branch 'b' used by worktree at 'Q:/existing'",
      },
      { code: 0, stdout: 'local-sha\n', stderr: '' },
    ]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => true },
      { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
    );
    expect(result).toEqual({
      worktreePath: 'Q:/existing',
      branch: 'b',
      tracksPullRequest: true,
      headSha: 'local-sha',
    });
  });

  it.each([1, 0])('creates a verified checkout rather than certifying an unresolved in-place HEAD (exit %i)', async (code) => {
    const { git } = gitRecorder([
      ok,
      { code: 0, stdout: 'fetched\n', stderr: '' },
      ok,
      {
        code: 1,
        stdout: '',
        stderr: "used by worktree at 'Q:/src/CosmosDB'",
      },
      { code, stdout: '', stderr: 'no HEAD' },
    ]);
    const result = await provisionPrWorktree(
      { git, pathExists: () => false },
      { repoLocalPath, provider: 'github', number: 9, sourceBranch: 'b' },
    );
    expect(result.worktreePath).not.toBe('Q:/src/CosmosDB');
    expect(result).toMatchObject({ tracksPullRequest: false, headSha: 'fetched' });
  });

  it('favourites the branch first and reports each phase to the status listener', async () => {
    const { git, calls } = gitRecorder([ok, { code: 0, stdout: 'abc\n', stderr: '' }]);
    const favouriteBranch = vi.fn(async () => ({
      ok: true,
      message: 'Marked "topic/x" as favourite.',
    }));
    const statuses: ProvisionStatus[] = [];
    await provisionPrWorktree(
      { git, pathExists: () => false, favouriteBranch },
      { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
      (status) => statuses.push(status),
    );
    expect(favouriteBranch).toHaveBeenCalledTimes(1);
    expect(statuses.map((s) => s.phase)).toEqual([
      'favouriting',
      'favouriting',
      'fetching',
      'preparing',
    ]);
    // The second favouriting status carries the outcome message.
    expect(statuses[1].message).toBe('Marked "topic/x" as favourite.');
    expect(calls[0]).toEqual(['-C', repoLocalPath, 'fetch', '--no-write-fetch-head', '--no-auto-maintenance', 'origin', '+topic/x:refs/ai-project-studio/pr/7']);
  });

  it('proceeds with the checkout when favouriting throws', async () => {
    const { git } = gitRecorder([ok, { code: 0, stdout: 'abc\n', stderr: '' }]);
    const favouriteBranch = vi.fn(async () => {
      throw new Error('favourite failed');
    });
    const statuses: ProvisionStatus[] = [];
    const result = await provisionPrWorktree(
      { git, pathExists: () => false, favouriteBranch },
      { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
      (status) => statuses.push(status),
    );
    expect(favouriteBranch).toHaveBeenCalledTimes(1);
    expect(result.branch).toBe('topic/x');
    expect(result.headSha).toBe('abc');
    expect(statuses[1].message).toContain('favourite failed');
  });

  it('stringifies a non-Error favourite failure', async () => {
    const { git } = gitRecorder([ok, { code: 0, stdout: 'abc\n', stderr: '' }]);
    const favouriteBranch = vi.fn(async () => {
      throw 'plain string failure';
    });
    const statuses: ProvisionStatus[] = [];
    await provisionPrWorktree(
      { git, pathExists: () => false, favouriteBranch },
      { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
      (status) => statuses.push(status),
    );
    expect(statuses[1].message).toContain('plain string failure');
  });

  it('explains the favourite outcome when the Azure fetch still fails', async () => {
    const { git } = gitRecorder([
      { code: 1, stdout: '', stderr: "fatal: couldn't find remote ref topic/x" },
      {
        code: 1,
        stdout: '',
        stderr: "fatal: couldn't find remote ref refs/pull/7/merge",
      },
    ]);
    const favouriteBranch = vi.fn(async () => ({
      ok: false,
      message: "Couldn't favourite branch (HTTP 403).",
    }));
    await expect(
      provisionPrWorktree(
        { git, pathExists: () => false, favouriteBranch },
        { repoLocalPath, provider: 'azure-devops', number: 7, sourceBranch: 'topic/x' },
      ),
    ).rejects.toThrow(/Auto-favourite result: Couldn't favourite branch \(HTTP 403\)/);
  });
});

describe('checkedOutWorktreePath', () => {
  it('extracts the path a branch is already checked out in', () => {
    expect(
      checkedOutWorktreePath(
        "fatal: cannot force update the branch 'x' used by worktree at 'Q:/src/CosmosDB'",
      ),
    ).toBe('Q:/src/CosmosDB');
  });

  it('returns null for unrelated errors', () => {
    expect(checkedOutWorktreePath('fatal: some other failure')).toBeNull();
  });
});

describe('describeWorktreeFailure', () => {
  it('explains the Windows long-path limit for "Filename too long"', () => {
    expect(describeWorktreeFailure('Filename too long', 'fallback')).toMatch(
      /LongPathsEnabled/,
    );
  });

  it('explains it for "unable to create file" too', () => {
    expect(
      describeWorktreeFailure('error: unable to create file foo', 'fallback'),
    ).toMatch(/long paths/i);
  });

  it('passes other stderr through unchanged', () => {
    expect(describeWorktreeFailure('some other error', 'fallback')).toBe(
      'some other error',
    );
  });

  it('falls back when stderr is empty', () => {
    expect(describeWorktreeFailure('   ', 'fallback message')).toBe(
      'fallback message',
    );
  });
});

describe('describeFetchFailure', () => {
  const base = {
    repoLocalPath,
    provider: 'azure-devops' as const,
    number: 7,
    sourceBranch: 'topic/x',
  };

  it('gives favourite/publish guidance for an unresolvable Azure ref', () => {
    expect(
      describeFetchFailure(base, "fatal: couldn't find remote ref topic/x"),
    ).toMatch(/favourite \/ publish it/i);
  });

  it('includes the auto-favourite outcome when one is provided', () => {
    const message = describeFetchFailure(
      base,
      "fatal: couldn't find remote ref topic/x",
      "Couldn't favourite branch (HTTP 403).",
    );
    expect(message).toContain('Auto-favourite result:');
    expect(message).toContain('HTTP 403');
  });

  it('passes other Azure fetch errors through unchanged', () => {
    expect(describeFetchFailure(base, 'fatal: authentication failed')).toBe(
      'fatal: authentication failed',
    );
  });

  it('passes GitHub fetch errors through unchanged', () => {
    expect(
      describeFetchFailure(
        { ...base, provider: 'github' },
        "fatal: couldn't find remote ref pull/7/head",
      ),
    ).toBe("fatal: couldn't find remote ref pull/7/head");
  });

  it('falls back to a default message when stderr is empty', () => {
    expect(describeFetchFailure(base, '   ')).toBe(
      'Failed to fetch pull request #7',
    );
  });
});
