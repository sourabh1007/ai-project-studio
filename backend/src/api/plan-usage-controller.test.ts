import { describe, it, expect } from 'vitest';
import { createPlanUsageRoutes } from './plan-usage-controller.js';
import type { PlanUsageService } from '../plan-usage/plan-usage-service.js';
import type { PlanUsage } from '../plan-usage/plan-usage-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

const req = (): HttpRequest => ({ params: {}, query: {}, body: undefined });

const snapshot: PlanUsage = {
  percentUsed: 2,
  usedAic: 25000,
  totalAic: 1000000,
  availableAic: 975000,
  resetInDays: 26,
  sessionAic: 0,
  capturedAt: '2026-09-04T00:00:00.000Z',
};

describe('plan-usage-controller', () => {
  it('serves the plan budget snapshot', async () => {
    const planUsage = {
      read: async () => snapshot,
    } as unknown as PlanUsageService;
    const res = await pick(createPlanUsageRoutes({ planUsage }), 'get', '/usage/plan')(
      req(),
    );
    expect(res).toEqual({ status: 200, body: snapshot });
  });

  it('returns a null body when no snapshot is available yet', async () => {
    const planUsage = {
      read: async () => null,
    } as unknown as PlanUsageService;
    const res = await pick(createPlanUsageRoutes({ planUsage }), 'get', '/usage/plan')(
      req(),
    );
    expect(res).toEqual({ status: 200, body: null });
  });
});
