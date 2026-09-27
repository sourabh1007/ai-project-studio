import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSharedCheckoutPreparer, type GitRunResult } from '../session-worktree/shared-session-checkout.js';

const git = (args: string[]): Promise<GitRunResult> => new Promise((resolve) => {
  execFile('git', args, { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) =>
    resolve({ code: error ? 1 : 0, stdout, stderr }));
});
const run = async (args: string[]) => {
  const result = await git(args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const commit = (cwd: string) => run([
  '-C', cwd, '-c', 'user.name=Session Test', '-c', 'user.email=session@example.invalid',
  '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture',
]);

it('opens the same master directly, preserves local edits and reuses PR checkouts without copies', async () => {
  const base = await mkdtemp(join(tmpdir(), 'session-shared-'));
  const source = join(base, 'app');
  const prPath = join(base, 'pr-review');
  try {
    await run(['init', '-b', 'master', source]);
    await writeFile(join(source, 'file.txt'), 'master\n');
    await run(['-C', source, 'add', '.']); await commit(source);
    await run(['-C', source, 'checkout', '-b', 'users/me/pr']);
    await writeFile(join(source, 'pr.txt'), 'PR changes\n');
    await run(['-C', source, 'add', '.']); await commit(source);
    await run(['-C', source, 'checkout', 'master']);
    await run(['-C', source, 'worktree', 'add', prPath, 'users/me/pr']);
    await run(['-C', source, 'checkout', '-b', 'scratch']);
    await writeFile(join(source, 'file.txt'), 'scratch changes\n');
    await run(['-C', source, 'add', '.']); await commit(source);
    await writeFile(join(source, 'file.txt'), 'unsaved changes\n');
    const calls: string[][] = [];
    const prepare = createSharedCheckoutPreparer({
      git: (args) => { calls.push(args); return git(args); },
    });
    const target = { repoLocalPath: source, ref: 'master' };
    await expect(prepare(target)).rejects.toThrow('overwritten');
    expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('unsaved changes\n');
    expect(await run(['-C', source, 'branch', '--show-current'])).toBe('scratch');
    await writeFile(join(source, 'file.txt'), 'scratch changes\n');
    const refs = await run(['-C', source, 'for-each-ref', '--format=%(refname)', 'refs/heads']);
    const [one, two] = await Promise.all([prepare(target), prepare(target)]);
    expect(one).toBe(source); expect(two).toBe(source);
    expect(await run(['-C', source, 'branch', '--show-current'])).toBe('master');
    expect(await prepare({ ...target, ref: 'users/me/pr', checkoutPath: prPath })).toBe(prPath);
    expect(await run(['-C', prPath, 'branch', '--show-current'])).toBe('users/me/pr');
    await run(['-C', source, 'checkout', 'scratch']);
    expect(await run(['-C', one, 'branch', '--show-current'])).toBe('scratch');
    expect(await run(['-C', two, 'branch', '--show-current'])).toBe('scratch');
    expect(await prepare(target, undefined, false)).toBe(source);
    expect(await run(['-C', source, 'branch', '--show-current'])).toBe('scratch');
    await prepare(target);
    expect(await run(['-C', source, 'branch', '--show-current'])).toBe('master');
    expect(await run(['-C', source, 'for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe(refs);
    expect((await readdir(base)).sort()).toEqual(['app', 'pr-review']);
    await expect(access(join(base, '.ai-worktrees'))).rejects.toThrow();
    for (const forbidden of ['clone', 'fetch', 'worktree', 'reset', '--force', '-B', '-b', '--detach']) {
      expect(calls.flat()).not.toContain(forbidden);
    }
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);
