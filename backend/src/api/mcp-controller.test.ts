import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../kernel/error-types.js';
import type { McpService } from '../mcp/mcp-service.js';
import type { HttpRequest } from './http-contract.js';
import { createMcpRoutes } from './mcp-controller.js';

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

function serviceStub(overrides: Partial<McpService> = {}): McpService {
  return {
    listProviders: vi.fn(() => [{ id: 'agency' }]),
    getServers: vi.fn(async () => ({
      providerId: 'agency',
      configPath: '/x/mcp-config.json',
      exists: true,
      servers: [],
    })),
    putServer: vi.fn(async () => ({
      providerId: 'agency',
      configPath: '/x/mcp-config.json',
      exists: true,
      servers: [{ name: 'a', spec: { command: 'a' } }],
    })),
    ...overrides,
  };
}

function routeFor(routes: ReturnType<typeof createMcpRoutes>, sig: string) {
  const route = routes.find((r) => `${r.method} ${r.path}` === sig);
  if (!route) throw new Error(`route not found: ${sig}`);
  return route;
}

describe('createMcpRoutes', () => {
  it('exposes the expected route table', () => {
    const routes = createMcpRoutes({ mcp: serviceStub() });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'get /mcp/providers',
      'get /mcp/providers/:providerId/servers',
      'put /mcp/providers/:providerId/servers',
    ]);
  });

  it('lists providers', async () => {
    const mcp = serviceStub();
    const route = routeFor(createMcpRoutes({ mcp }), 'get /mcp/providers');
    expect(await route.handler(req())).toEqual({
      status: 200,
      body: [{ id: 'agency' }],
    });
  });

  it('gets a provider’s servers', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'get /mcp/providers/:providerId/servers',
    );
    const result = await route.handler(req({ params: { providerId: 'agency' } }));
    expect(mcp.getServers).toHaveBeenCalledWith('agency');
    expect(result.status).toBe(200);
  });

  it('adds/updates a server with a valid body', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'put /mcp/providers/:providerId/servers',
    );
    const result = await route.handler(
      req({
        params: { providerId: 'agency' },
        body: { name: 'a', spec: { command: 'a' } },
      }),
    );
    expect(mcp.putServer).toHaveBeenCalledWith('agency', {
      name: 'a',
      spec: { command: 'a' },
    });
    expect(result.status).toBe(200);
  });

  it('rejects an invalid put body', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'put /mcp/providers/:providerId/servers',
    );
    await expect(
      route.handler(req({ params: { providerId: 'agency' }, body: { name: '' } })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mcp.putServer).not.toHaveBeenCalled();
  });
});
