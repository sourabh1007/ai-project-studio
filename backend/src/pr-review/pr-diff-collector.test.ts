import { describe, expect, it } from 'vitest';
import { createPrDiffCollector, type GitCommandResult } from './pr-diff-collector.js';

function ok(stdout: string): GitCommandResult {
  return { code: 0, stdout, stderr: '' };
}

function gitStub(map: Record<string, GitCommandResult>) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const git = {
    run: async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      const key = args.join(' ');
      return map[key] ?? ok('');
    },
  };
  return { git, calls };
}

describe('createPrDiffCollector', () => {
  it('collects a bounded diff against origin/<base> using three-dot range', async () => {
    const { git, calls } = gitStub({
      'diff --stat origin/main...HEAD': ok(' a.ts | 2 +-'),
      'diff --name-only origin/main...HEAD': ok('a.ts\nb.ts\n'),
      'diff origin/main...HEAD': ok('@@ patch @@'),
    });
    const collector = createPrDiffCollector({ git, config: { maxPatchChars: 100 } });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff).toEqual({
      baseRef: 'origin/main',
      changedFiles: 2,
      stat: ' a.ts | 2 +-',
      patch: '@@ patch @@',
      truncated: false,
    });
    expect(calls.every((c) => c.cwd === 'C:\\wt')).toBe(true);
  });

  it('uses HEAD and a null base ref when no base branch is known', async () => {
    const { git } = gitStub({
      'diff --stat HEAD': ok(''),
      'diff --name-only HEAD': ok(''),
      'diff HEAD': ok(''),
    });
    const collector = createPrDiffCollector({ git, config: { maxPatchChars: 100 } });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: null,
    });

    expect(diff.baseRef).toBeNull();
    expect(diff.changedFiles).toBe(0);
  });

  it('truncates an oversized patch to the budget', async () => {
    const { git } = gitStub({
      'diff --stat origin/main...HEAD': ok('stat'),
      'diff --name-only origin/main...HEAD': ok('a.ts'),
      'diff origin/main...HEAD': ok('x'.repeat(50)),
    });
    const collector = createPrDiffCollector({ git, config: { maxPatchChars: 10 } });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.truncated).toBe(true);
    expect(diff.patch).toBe('x'.repeat(10));
  });

  it('throws with git stderr when a diff command fails', async () => {
    const { git } = gitStub({
      'diff --stat origin/main...HEAD': {
        code: 128,
        stdout: '',
        stderr: 'fatal: bad revision',
      },
    });
    const collector = createPrDiffCollector({ git, config: { maxPatchChars: 100 } });

    await expect(
      collector.collect({ worktreePath: 'C:\\wt', baseBranch: 'main' }),
    ).rejects.toThrow('git diff --stat failed: fatal: bad revision');
  });

  it('falls back to an exit-code message when stderr is empty', async () => {
    const { git } = gitStub({
      'diff --stat origin/main...HEAD': { code: 1, stdout: '', stderr: '   ' },
    });
    const collector = createPrDiffCollector({ git, config: { maxPatchChars: 100 } });

    await expect(
      collector.collect({ worktreePath: 'C:\\wt', baseBranch: 'main' }),
    ).rejects.toThrow('git diff --stat failed: exit 1');
  });
});
