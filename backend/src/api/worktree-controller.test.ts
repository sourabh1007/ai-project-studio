import { describe, expect, it } from 'vitest';
import { createWorktreeRoutes } from './worktree-controller.js';
import type { WorktreeService } from '../worktrees/worktree-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`No route ${method} ${path}`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

function harness() {
  const calls: Record<string, unknown[]> = {};
  const worktrees = {
    list: async () => ((calls.list = []), [
      { path: '/w/app-pr-7', branch: 'pr-7', repoId: 'r1', repoName: 'app', pullNumber: 7 },
    ]),
    remove: async (path: string) => void (calls.remove = [path]),
    removeForFeature: async () => undefined,
  } as unknown as WorktreeService;
  return { routes: createWorktreeRoutes({ worktrees }), calls };
}

describe('createWorktreeRoutes', () => {
  it('lists managed worktrees', async () => {
    const { routes, calls } = harness();
    const res = await pick(routes, 'get', '/worktrees')(req());
    expect(res.status).toBe(200);
    expect(calls.list).toEqual([]);
    expect((res.body as unknown[]).length).toBe(1);
  });

  it('removes a worktree by path', async () => {
    const { routes, calls } = harness();
    const res = await pick(routes, 'post', '/worktrees/remove')(
      req({ body: { path: '/w/app-pr-7' } }),
    );
    expect(res).toEqual({ status: 200, body: { removed: true } });
    expect(calls.remove).toEqual(['/w/app-pr-7']);
  });

  it('rejects a remove request without a path', async () => {
    const { routes } = harness();
    await expect(
      pick(routes, 'post', '/worktrees/remove')(req({ body: {} })),
    ).rejects.toThrow('non-empty worktree "path"');
  });
});
