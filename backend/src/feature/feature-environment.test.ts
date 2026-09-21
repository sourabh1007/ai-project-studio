import { describe, expect, it, vi } from 'vitest';
import { createFeatureEnvironmentResolver } from './feature-environment.js';

describe('feature-environment resolver', () => {
  it('returns the resolved cwd and its branch', async () => {
    const read = vi.fn(async () => 'pr-42');
    const resolver = createFeatureEnvironmentResolver({
      resolveCwd: (id) => (id === 'f1' ? 'C:/work/.ai-worktrees/app-pr-42' : undefined),
      branch: { read },
    });

    const env = await resolver.resolve('f1');

    expect(env).toEqual({ cwd: 'C:/work/.ai-worktrees/app-pr-42', branch: 'pr-42' });
    expect(read).toHaveBeenCalledWith('C:/work/.ai-worktrees/app-pr-42');
  });

  it('reports a null branch when the checkout branch cannot be read', async () => {
    const resolver = createFeatureEnvironmentResolver({
      resolveCwd: () => 'C:/repo',
      branch: { read: async () => null },
    });

    expect(await resolver.resolve('f1')).toEqual({ cwd: 'C:/repo', branch: null });
  });

  it('skips the branch read for a repo-less feature', async () => {
    const read = vi.fn(async () => 'main');
    const resolver = createFeatureEnvironmentResolver({
      resolveCwd: () => undefined,
      branch: { read },
    });

    expect(await resolver.resolve('f1')).toEqual({ cwd: null, branch: null });
    expect(read).not.toHaveBeenCalled();
  });
});
