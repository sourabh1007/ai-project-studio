import { describe, expect, it, vi } from 'vitest';
import { createGitReviewContextSource, type ReviewContextCommandRunner } from './review-context-git.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const blob = 'd'.repeat(40);
const tree = (path = 'AGENTS.md', size: string | number = 4, mode = '100644', id = blob) => `${mode} blob ${id} ${size}\t${path}\0`;

function runner(outputs: (string | Buffer | Error)[]): ReviewContextCommandRunner & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(async () => {
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    if (output === undefined) throw new Error('No mocked output');
    return { stdout: output };
  }) };
}

describe('pinned Git context source', () => {
  it.each([undefined, new AbortController().signal])('fetches a missing immutable live target without updating refs or the working tree (%s)', async (signal) => {
    const commands = runner([head, new Error('missing target object'), '', base, merge]);
    expect(await createGitReviewContextSource(commands).pin('repo', head, base, signal))
      .toEqual({ headSha: head, baseSha: base, mergeBaseSha: merge });
    expect(commands.run.mock.calls[2]![1].slice(3))
      .toEqual(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', base]);
    await expect(createGitReviewContextSource(runner([head, new Error('missing'), new Error('offline')])).pin('repo', head, base))
      .rejects.toThrow('offline');
    await expect(createGitReviewContextSource(runner([head, new Error('missing ref')])).pin('repo', head, 'origin/main'))
      .rejects.toThrow('missing ref');
    const controller = new AbortController();
    let calls = 0;
    const aborted: ReviewContextCommandRunner = { run: vi.fn(async () => {
      if (++calls === 1) return { stdout: head };
      controller.abort(new Error('cancelled'));
      throw new Error('missing');
    }) };
    await expect(createGitReviewContextSource(aborted).pin('repo', head, base, controller.signal)).rejects.toThrow('cancelled');
    expect(aborted.run).toHaveBeenCalledTimes(2);
  });
  it('scopes large-repository discovery to literal guidance paths in bounded argument batches', async () => {
    const paths = Array.from({ length: 17 }, (_, index) => `rules/group-${index}`);
    const commands = runner([tree('rules/a.md') + tree('rules/a.md'), tree('rules/b.md')]);
    const result = await createGitReviewContextSource(commands).listFiles('repo', base, undefined, paths);
    expect(result.files.map((file) => file.path)).toEqual(['rules/a.md', 'rules/b.md']);
    expect(result.truncated).toBe(false);
    expect(commands.run.mock.calls.map((call) => call[1].slice(3))).toEqual([
      ['ls-tree', '-r', '-z', '-l', base, '--', ...paths.slice(0, 16)],
      ['ls-tree', '-r', '-z', '-l', base, '--', paths[16]],
    ]);
    const empty = runner([]);
    expect(await createGitReviewContextSource(empty).listFiles('repo', base, undefined, [])).toEqual({ files: [], truncated: false });
    await expect(createGitReviewContextSource(empty).listFiles('repo', base, undefined, ['../rules'])).rejects.toThrow('Unsafe guidance');
    expect(empty.run).not.toHaveBeenCalled();
  });
  it('pins exact head, target and merge-base using bounded non-shell argument arrays', async () => {
    const commands = runner([`${head}\n`, `${base}\n`, `${merge}\n`]);
    const port = createGitReviewContextSource(commands);
    expect(await port.pin('C:\\repo', head, 'origin/main')).toEqual({ headSha: head, baseSha: base, mergeBaseSha: merge });
    expect(commands.run.mock.calls.map((call) => call[1].slice(3))).toEqual([
      ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`],
      ['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}'],
      ['merge-base', head, base],
    ]);
    expect(commands.run.mock.calls[0]![2]).toMatchObject({ cwd: 'C:\\repo', maxBuffer: 524288, timeout: 10000 });
    expect(commands.run.mock.calls[0]![1].slice(0, 3)).toEqual(['--no-pager', '--no-optional-locks', '--literal-pathspecs']);
  });

  it('rejects missing and hostile head/target revisions without executing them', async () => {
    const commands = runner([]);
    const port = createGitReviewContextSource(commands);
    await expect(port.pin('repo', null, 'main')).rejects.toThrow('no pinned HEAD');
    await expect(port.pin('repo', '--evil', 'main')).rejects.toThrow('Invalid pinned');
    for (const ref of [null, '', '--evil', 'main;curl', 'main$(bad)', 'main^', 'main~1', 'a..b', 'a//b', '.git', 'refs/.hidden/main', 'a.lock', 'a.lock/b', 'main/', 'main.', 'main@{1}']) {
      await expect(port.pin('repo', head, ref)).rejects.toThrow('Invalid Git target');
    }
    expect(commands.run).not.toHaveBeenCalled();
  });

  it('validates command results and never falls back to checkout HEAD', async () => {
    await expect(createGitReviewContextSource(runner(['bad'])).pin('repo', head, 'main')).rejects.toThrow('Invalid pinned');
    await expect(createGitReviewContextSource(runner([base])).pin('repo', head, 'main')).rejects.toThrow('does not match');
    await expect(createGitReviewContextSource(runner([head, 'bad'])).pin('repo', head, 'main')).rejects.toThrow('Invalid pinned');
    await expect(createGitReviewContextSource(runner([head, base, 'bad'])).pin('repo', head, 'main')).rejects.toThrow('Invalid pinned');
    await expect(createGitReviewContextSource(runner([new Error('git failed')])).pin('repo', head, 'main')).rejects.toThrow('git failed');
    const long = 'a'.repeat(64);
    expect((await createGitReviewContextSource(runner([long, long, long])).pin('repo', long, 'refs/heads/main')).headSha).toBe(long);
  });

  it('enumerates only bounded pinned tracked tree entries with modes and blob IDs', async () => {
    const commands = runner([Buffer.from(tree('Src/AGENTS.md') + tree('AGENTS.md') + '\0')]);
    const result = await createGitReviewContextSource(commands, { maxFiles: 1 }).listFiles('repo', base);
    expect(result.files).toEqual([{ path: 'Src/AGENTS.md', mode: '100644', objectId: blob, size: 4 }]);
    expect(result.truncated).toBe(true);
    expect(commands.run.mock.calls[0]![1].slice(3)).toEqual(['ls-tree', '-r', '-z', '-l', base]);
    expect(await createGitReviewContextSource(runner([''])).listFiles('repo', base)).toEqual({ files: [], truncated: false });
    await expect(createGitReviewContextSource(runner(['bad\0'])).listFiles('repo', base)).rejects.toThrow('Malformed');
    await expect(createGitReviewContextSource(runner([])).listFiles('repo', 'HEAD')).rejects.toThrow('Invalid pinned');
  });

  it('reads exact regular blobs and treats shell-like filenames literally', async () => {
    const path = 'src/$(curl evil); name.ts';
    const commands = runner([tree(path), Buffer.from('text')]);
    const result = await createGitReviewContextSource(commands).readFile('repo', head, path);
    expect(result).toEqual({ content: 'text' });
    expect(commands.run.mock.calls[0]![1].slice(3)).toEqual(['ls-tree', '-z', '-l', head, '--', path]);
    expect(commands.run.mock.calls[1]![1].slice(3)).toEqual(['cat-file', 'blob', blob]);
    expect(await createGitReviewContextSource(runner([tree('AGENTS.md', 4, '100755'), 'text'])).readFile('repo', head, 'AGENTS.md')).toEqual({ content: 'text' });
  });

  it('rejects unsafe paths, symlinks/submodules, absent blobs and oversize objects before object reads', async () => {
    const commands = runner([]);
    await expect(createGitReviewContextSource(commands).readFile('repo', head, '../AGENTS.md')).rejects.toThrow('Unsafe');
    expect(commands.run).not.toHaveBeenCalled();
    expect(await createGitReviewContextSource(runner([''])).readFile('repo', head, 'AGENTS.md')).toEqual({ content: null });
    expect(await createGitReviewContextSource(runner([tree('different')])).readFile('repo', head, 'AGENTS.md')).toEqual({ content: null });
    for (const [mode, size] of [['120000', '8'], ['160000', '-'], ['100644', '9007199254740992'], ['100644', '-']]) {
      const run = runner([tree('AGENTS.md', size!, mode!)]);
      expect(await createGitReviewContextSource(run).readFile('repo', head, 'AGENTS.md')).toEqual({ content: null, unsupported: true });
      expect(run.run).toHaveBeenCalledTimes(1);
    }
    const run = runner([tree('AGENTS.md', 999999)]);
    expect(await createGitReviewContextSource(run).readFile('repo', head, 'AGENTS.md')).toEqual({ content: null, truncated: true });
    expect(run.run).toHaveBeenCalledTimes(1);
  });

  it('rejects binary/invalid encoding and bounds data even if tree metadata is inconsistent', async () => {
    for (const text of ['a\0b', '\uFFFD']) {
      expect(await createGitReviewContextSource(runner([tree(), text])).readFile('repo', head, 'AGENTS.md'))
        .toEqual({ content: null, unsupported: true });
    }
    expect(await createGitReviewContextSource(runner([tree(), 'x'.repeat(9)]), { maxFileBytes: 8 }).readFile('repo', head, 'AGENTS.md'))
      .toEqual({ content: null, truncated: true });
    expect(await createGitReviewContextSource(runner([tree('AGENTS.md', 0), ''])).readFile('repo', head, 'AGENTS.md')).toEqual({ content: '' });
  });

  it('enforces output/time limits, failure propagation and abort before/after commands', async () => {
    await expect(createGitReviewContextSource(runner(['x'.repeat(5)]), { maxCommandBytes: 4 }).listFiles('repo', head))
      .rejects.toThrow('output exceeded');
    const before = new AbortController();
    before.abort(new Error('cancelled'));
    const commands = runner([]);
    await expect(createGitReviewContextSource(commands).listFiles('repo', head, before.signal)).rejects.toThrow('cancelled');
    expect(commands.run).not.toHaveBeenCalled();
    const after = new AbortController();
    const run: ReviewContextCommandRunner = { run: async () => { after.abort(new Error('after')); return { stdout: '' }; } };
    await expect(createGitReviewContextSource(run).listFiles('repo', head, after.signal)).rejects.toThrow('after');
    await expect(createGitReviewContextSource(runner([new Error('timeout')])).readFile('repo', head, 'AGENTS.md')).rejects.toThrow('timeout');
  });
});
