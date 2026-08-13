import { describe, it, expect } from 'vitest';
import { createHealthRoutes } from './health-controller.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

describe('health-controller', () => {
  it('reports ok with computed uptime from injected clock', async () => {
    let clock = 1000;
    const result = await pick(
      createHealthRoutes({ now: () => clock, startedAt: 250 }),
      'get',
      '/health',
    )(req());

    expect(result).toEqual({
      status: 200,
      body: { status: 'ok', uptimeMs: 750 },
    });
    clock = 250; // sanity: handler recomputes each call
  });

  it('defaults startedAt to the first now() reading', async () => {
    const readings = [500, 900];
    const now = () => readings.shift() ?? 900;
    const routes = createHealthRoutes({ now });
    const result = await pick(routes, 'get', '/health')(req());

    expect(result).toEqual({
      status: 200,
      body: { status: 'ok', uptimeMs: 400 },
    });
  });

  it('never reports negative uptime when the clock goes backwards', async () => {
    const result = await pick(
      createHealthRoutes({ now: () => 100, startedAt: 500 }),
      'get',
      '/health',
    )(req());

    expect(result).toEqual({
      status: 200,
      body: { status: 'ok', uptimeMs: 0 },
    });
  });

  it('uses wall-clock defaults when no deps are provided', async () => {
    const before = Date.now();
    const result = await pick(createHealthRoutes(), 'get', '/health')(req());
    const after = Date.now();

    expect(result.status).toBe(200);
    const body = result.body as { status: string; uptimeMs: number };
    expect(body.status).toBe('ok');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.uptimeMs).toBeLessThanOrEqual(after - before + 50);
  });
});
