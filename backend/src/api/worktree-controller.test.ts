import { describe, expect, it } from 'vitest';
import { createWorktreeRoutes } from './worktree-controller.js';
import type { WorktreeService } from '../worktrees/worktree-contract.js';
import type { HttpRequest, Route } from './http-contract.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mountRoutes } from './express-adapter.js';
import { createHealthRoutes } from './health-controller.js';
import { createWorktreeService } from '../worktrees/worktree-service.js';

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
  it('serves health and list requests while two independent removals wait on asynchronous Git', async () => {
    let finish!: () => void;
    let bothStarted!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    let active = 0;
    const worktrees = createWorktreeService({
      repos: {
        list: () => [{ id: 'r1', name: 'app', localPath: '/repos/app', provider: 'github', remoteUrl: '', defaultBranch: 'master', createdAt: '' }],
        get: () => null,
      },
      reviews: { find: () => null },
      git: {
        run: async (args) => {
          if (args[1] === 'remove') {
            active += 1;
            if (active === 2) bothStarted();
            await held;
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      },
      removeDir: async () => undefined,
    });
    const app = express();
    app.use(express.json());
    mountRoutes(app, [...createWorktreeRoutes({ worktrees }), ...createHealthRoutes()]);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => { server.once('listening', resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const removals = [1, 2].map((id) => fetch(`${base}/worktrees/remove`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `/repos/.ai-worktrees/app-task-${id}` }),
      signal: AbortSignal.timeout(5_000),
    }));
    try {
      await started;
      const [health, list] = await Promise.all([
        fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) }),
        fetch(`${base}/worktrees`, { signal: AbortSignal.timeout(2_000) }),
      ]);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok' });
      expect(await list.json()).toEqual([]);
      expect(active).toBe(2);
      finish();
      for (const response of await Promise.all(removals)) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ removed: true });
      }
    } finally {
      finish();
      await Promise.allSettled(removals);
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

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
