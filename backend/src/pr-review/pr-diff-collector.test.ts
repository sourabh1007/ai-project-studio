import { describe, expect, it } from 'vitest';
import { createPrDiffCollector, type GitCommandResult } from './pr-diff-collector.js';

function ok(stdout: string): GitCommandResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(): GitCommandResult {
  return { code: 1, stdout: '', stderr: '' };
}

function cfg(maxPatchChars: number, maxFileDiffChars = 1_000) {
  return { maxPatchChars, maxFileDiffChars };
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

/** A two-file unified diff: one modified, one added. */
const TWO_FILE_PATCH = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/b.ts b/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/b.ts',
  '@@ -0,0 +1 @@',
  '+brand new',
].join('\n');

describe('createPrDiffCollector', () => {
  it('collects a bounded diff against origin/<base> using three-dot range', async () => {
    const { git, calls } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc123'),
      'diff --stat origin/main...HEAD': ok(' a.ts | 2 +-'),
      'diff --name-status origin/main...HEAD': ok('M\ta.ts\nA\tb.ts\n'),
      'diff origin/main...HEAD': ok(TWO_FILE_PATCH),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.baseRef).toBe('origin/main');
    expect(diff.changedFiles).toBe(2);
    expect(diff.files).toEqual(['a.ts', 'b.ts']);
    expect(diff.truncated).toBe(false);
    expect(diff.entries).toEqual([
      {
        path: 'a.ts',
        status: 'modified',
        patch: [
          'diff --git a/a.ts b/a.ts',
          'index 111..222 100644',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n'),
      },
      {
        path: 'b.ts',
        status: 'added',
        patch: [
          'diff --git a/b.ts b/b.ts',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/b.ts',
          '@@ -0,0 +1 @@',
          '+brand new',
        ].join('\n'),
      },
    ]);
    expect(calls.every((c) => c.cwd === 'C:\\wt')).toBe(true);
  });

  it('derives change kinds for deletes and renames', async () => {
    const patch = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': ok('stat'),
      'diff --name-status origin/main...HEAD': ok(
        'D\tgone.ts\nR090\told.ts\tnew.ts\n',
      ),
      'diff origin/main...HEAD': ok(patch),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.files).toEqual(['gone.ts', 'new.ts']);
    expect(diff.entries[0]).toMatchObject({ path: 'gone.ts', status: 'deleted' });
    expect(diff.entries[0].patch).toContain('deleted file mode');
    expect(diff.entries[1]).toMatchObject({ path: 'new.ts', status: 'renamed' });
    expect(diff.entries[1].patch).toContain('rename to new.ts');
  });

  it('bounds each per-file patch to the configured budget', async () => {
    const bigPatch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '+' + 'x'.repeat(100),
    ].join('\n');
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': ok('stat'),
      'diff --name-status origin/main...HEAD': ok('M\ta.ts'),
      'diff origin/main...HEAD': ok(bigPatch),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000, 20) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.entries[0].patch).toBe(bigPatch.slice(0, 20));
  });

  it('leaves the per-file patch empty when the split finds no segment', async () => {
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': ok('stat'),
      'diff --name-status origin/main...HEAD': ok('M\ta.ts'),
      'diff origin/main...HEAD': ok('not a real diff header'),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.entries).toEqual([{ path: 'a.ts', status: 'modified', patch: '' }]);
  });

  it('skips a diff segment whose header exposes no path', async () => {
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': ok('stat'),
      'diff --name-status origin/main...HEAD': ok('M\ta.ts'),
      'diff origin/main...HEAD': ok('diff --git malformed-header\nsome body line'),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.entries).toEqual([{ path: 'a.ts', status: 'modified', patch: '' }]);
  });

  it('falls back to the local branch when origin/<base> is not fetched', async () => {
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': fail(),
      'rev-parse --verify --quiet main^{commit}': ok('def456'),
      'diff --stat main...HEAD': ok('stat'),
      'diff --name-status main...HEAD': ok('M\ta.ts'),
      'diff main...HEAD': ok('diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+x'),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.baseRef).toBe('main');
    expect(diff.files).toEqual(['a.ts']);
  });

  it('degrades to HEAD when neither origin nor local base ref resolves', async () => {
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': fail(),
      'rev-parse --verify --quiet main^{commit}': fail(),
      'diff --stat HEAD': ok(''),
      'diff --name-status HEAD': ok(''),
      'diff HEAD': ok(''),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.baseRef).toBeNull();
    expect(diff.changedFiles).toBe(0);
    expect(diff.files).toEqual([]);
    expect(diff.entries).toEqual([]);
  });

  it('uses HEAD and a null base ref when no base branch is known', async () => {
    const { git } = gitStub({
      'diff --stat HEAD': ok(''),
      'diff --name-status HEAD': ok(''),
      'diff HEAD': ok(''),
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: null,
    });

    expect(diff.baseRef).toBeNull();
    expect(diff.changedFiles).toBe(0);
  });

  it('keeps per-file diffs for files after the overall patch cutoff', async () => {
    const segA = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '+' + 'a'.repeat(100),
    ].join('\n');
    const segB = [
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '+bbb',
    ].join('\n');
    const patchRaw = segA + '\n' + segB;
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': ok('stat'),
      'diff --name-status origin/main...HEAD': ok('M\ta.ts\nM\tb.ts'),
      'diff origin/main...HEAD': ok(patchRaw),
    });
    // maxPatchChars cuts off inside segA, dropping segB from the prompt patch.
    const collector = createPrDiffCollector({ git, config: cfg(segA.length, 1000) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.truncated).toBe(true);
    const bEntry = diff.entries.find((e) => e.path === 'b.ts');
    expect(bEntry?.patch).toContain('+bbb');
  });

  it('truncates an oversized patch to the budget', async () => {    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': ok('stat'),
      'diff --name-status origin/main...HEAD': ok('M\ta.ts'),
      'diff origin/main...HEAD': ok('x'.repeat(50)),
    });
    const collector = createPrDiffCollector({ git, config: cfg(10) });

    const diff = await collector.collect({
      worktreePath: 'C:\\wt',
      baseBranch: 'main',
    });

    expect(diff.truncated).toBe(true);
    expect(diff.patch).toBe('x'.repeat(10));
  });

  it('throws with git stderr when a diff command fails', async () => {
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': {
        code: 128,
        stdout: '',
        stderr: 'fatal: bad revision',
      },
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    await expect(
      collector.collect({ worktreePath: 'C:\\wt', baseBranch: 'main' }),
    ).rejects.toThrow('git diff --stat failed: fatal: bad revision');
  });

  it('falls back to an exit-code message when stderr is empty', async () => {
    const { git } = gitStub({
      'rev-parse --verify --quiet origin/main^{commit}': ok('abc'),
      'diff --stat origin/main...HEAD': { code: 1, stdout: '', stderr: '   ' },
    });
    const collector = createPrDiffCollector({ git, config: cfg(1000) });

    await expect(
      collector.collect({ worktreePath: 'C:\\wt', baseBranch: 'main' }),
    ).rejects.toThrow('git diff --stat failed: exit 1');
  });
});
