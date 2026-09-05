import { describe, it, expect } from 'vitest';
import { createSelfHealRoutes } from './self-heal-controller.js';
import type { SelfHealService } from '../self-heal/self-heal-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

const req = (): HttpRequest => ({ params: {}, query: {}, body: undefined });

describe('self-heal-controller', () => {
  it('serves the catalog of heal targets', async () => {
    const targets = [
      {
        id: 'github-cli',
        title: 'GitHub CLI',
        description: 'd',
        strategy: 'install' as const,
      },
    ];
    const selfHeal = {
      list: () => targets,
      heal: async () => true,
    } as unknown as SelfHealService;
    const res = await pick(createSelfHealRoutes({ selfHeal }), 'get', '/self-heal')(
      req(),
    );
    expect(res).toEqual({ status: 200, body: { targets } });
  });
});
