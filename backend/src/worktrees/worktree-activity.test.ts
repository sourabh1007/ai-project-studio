import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createWorktreeActivityGuard, type WorktreeActivityDeps } from './worktree-activity.js';

const repo = resolve('activity-fixture', 'repo');
const target = resolve('activity-fixture', '.ai-worktrees', 'repo-pr-1');
const other = resolve('activity-fixture', '.ai-worktrees', 'other-pr-1');
function setup() {
  const deps: WorktreeActivityDeps = {
    repositories: () => [{ id: 'r', localPath: repo }],
    sessions: () => [],
    feature: () => ({ repoId: 'r', checkoutPath: target }),
    reviewPath: () => null,
    liveTerminal: () => false,
    scopes: () => [],
    metaScopes: () => [],
  };
  return { deps, guard: createWorktreeActivityGuard(deps) };
}
const session = (worktreePath?: string) => ({
  id: 's', featureId: 'f', status: 'running' as const, kind: 'dev' as const, worktreePath,
});
describe('worktree active producer guard', () => {
  it('always protects primary checkouts but allows genuinely idle managed worktrees', () => {
    const { guard } = setup();
    expect(guard(repo)).toBe(true);
    expect(guard(target)).toBe(false);
  });
  it('protects live terminals, running sessions and their nested cwd without matching unrelated checkouts', () => {
    const { deps, guard } = setup();
    deps.sessions = () => [session(resolve(target, 'subdirectory'))];
    expect(guard(target)).toBe(true);
    expect(guard(other)).toBe(false);
    deps.sessions = () => [{ ...session(), status: 'completed' }];
    expect(guard(target)).toBe(false);
    deps.liveTerminal = () => true;
    expect(guard(target)).toBe(true);
  });
  it('resolves feature/review/current primary cwd and missing attribution conservatively', () => {
    const { deps, guard } = setup();
    deps.sessions = () => [session()];
    deps.feature = () => ({ repoId: 'r' });
    deps.reviewPath = () => target;
    expect(guard(target)).toBe(true);
    deps.reviewPath = () => null;
    expect(guard(target)).toBe(false);
    deps.feature = () => null;
    expect(guard(target)).toBe(true);
    deps.feature = () => ({ repoId: null, checkoutPath: other });
    expect(guard(target)).toBe(false);
    deps.feature = () => ({ repoId: 'r' });
    deps.repositories = () => [{ id: 'r', localPath: target }];
    expect(guard(target)).toBe(true);
  });
  it('protects queued feature/session scopes and unknown sessions while ignoring unscoped health traffic', () => {
    const { deps, guard } = setup();
    deps.scopes = () => [{}];
    expect(guard(target)).toBe(false);
    deps.scopes = () => [{ featureId: 'f' }];
    expect(guard(target)).toBe(true);
    deps.feature = () => ({ repoId: 'r' });
    deps.scopes = () => [{ featureIds: ['f'] }];
    expect(guard(target)).toBe(true);
    expect(guard(other)).toBe(false);
    deps.scopes = () => [{ sessionIds: ['missing'] }];
    expect(guard(target)).toBe(true);
    deps.sessions = () => [{ ...session(target), status: 'created' }];
    deps.scopes = () => [{ sessionId: 's' }];
    expect(guard(target)).toBe(true);
  });
  it('protects unfinished/unconfirmed meta ownership including origin and physical session IDs', () => {
    const { deps, guard } = setup();
    deps.feature = () => ({ repoId: 'r' });
    deps.metaScopes = () => [{ featureId: 'f', originSessionId: null, sessionIds: [] }];
    expect(guard(target)).toBe(true);
    expect(guard(other)).toBe(false);
    deps.feature = () => ({ repoId: null, checkoutPath: other });
    deps.metaScopes = () => [{ featureId: 'f', originSessionId: 'missing', sessionIds: [] }];
    expect(guard(target)).toBe(true);
    deps.metaScopes = () => [{ featureId: 'f', originSessionId: null, sessionIds: ['missing'] }];
    expect(guard(target)).toBe(true);
    deps.metaScopes = () => [];
    deps.sessions = () => [{ ...session(), kind: 'meta' }];
    deps.feature = () => ({ repoId: 'r' });
    expect(guard(target)).toBe(true);
  });
  it('fails closed if a live registry cannot be read', () => {
    const { deps, guard } = setup();
    deps.scopes = () => { throw new Error('unavailable'); };
    expect(guard(target)).toBe(true);
  });
});
