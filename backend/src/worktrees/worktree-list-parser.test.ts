import { describe, expect, it } from 'vitest';
import {
  APP_WORKTREE_DIR,
  isAppWorktree,
  parseWorktreePorcelain,
  pullNumberFromPath,
} from './worktree-list-parser.js';

describe('parseWorktreePorcelain', () => {
  it('parses branch and detached worktrees', () => {
    const out = [
      'worktree /repos/app',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /repos/.ai-worktrees/app-pr-7',
      'HEAD bbb',
      'branch refs/heads/pr-7',
      '',
      'worktree /repos/detached',
      'HEAD ccc',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreePorcelain(out)).toEqual([
      { path: '/repos/app', branch: 'main' },
      { path: '/repos/.ai-worktrees/app-pr-7', branch: 'pr-7' },
      { path: '/repos/detached', branch: null },
    ]);
  });

  it('ignores a stray branch line with no current worktree', () => {
    expect(parseWorktreePorcelain('branch refs/heads/orphan')).toEqual([]);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});

describe('isAppWorktree', () => {
  it('matches paths under the managed directory on both separators', () => {
    expect(isAppWorktree(`/repos/${APP_WORKTREE_DIR}/app-pr-7`)).toBe(true);
    expect(isAppWorktree('C:\\repos\\.ai-worktrees\\app-pr-7')).toBe(true);
    expect(isAppWorktree('/repos/app')).toBe(false);
  });
});

describe('pullNumberFromPath', () => {
  it('extracts the PR number from the directory name', () => {
    expect(pullNumberFromPath('/repos/.ai-worktrees/app-pr-42')).toBe(42);
    expect(pullNumberFromPath('C:\\repos\\.ai-worktrees\\app-pr-3\\')).toBe(3);
  });

  it('returns null when the name has no pr suffix', () => {
    expect(pullNumberFromPath('/repos/.ai-worktrees/scratch')).toBeNull();
    expect(pullNumberFromPath('')).toBeNull();
  });
});
