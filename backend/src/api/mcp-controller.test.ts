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
    setToolEnabled: vi.fn(async () => ({
      config: {
        providerId: 'agency',
        configPath: '/x/mcp-config.json',
        exists: true,
        servers: [{ name: 'a', spec: { command: 'a' } }],
      },
      server: { name: 'a', spec: { command: 'a' } },
      liveReloadedSessions: 1,
      liveReloadCommand: '/restart',
    })),
    restartServer: vi.fn(async () => ({
      config: {
        providerId: 'agency',
        configPath: '/x/mcp-config.json',
        exists: true,
        servers: [{ name: 'a', spec: { command: 'a' } }],
      },
      server: { name: 'a', spec: { command: 'a' } },
      liveReloadedSessions: 1,
      liveReloadCommand: '/restart',
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
      'put /mcp/providers/:providerId/servers/:serverName/tools/:toolName',
      'post /mcp/providers/:providerId/servers/:serverName/restart',
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

  it('toggles an MCP tool', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'put /mcp/providers/:providerId/servers/:serverName/tools/:toolName',
    );
    const result = await route.handler(
      req({
        params: { providerId: 'agency', serverName: 'Azure', toolName: 'read' },
        body: { enabled: false },
      }),
    );
    expect(mcp.setToolEnabled).toHaveBeenCalledWith('agency', {
      serverName: 'Azure',
      toolName: 'read',
      enabled: false,
    });
    expect(result.status).toBe(200);
  });

  it('rejects an invalid tool toggle body', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'put /mcp/providers/:providerId/servers/:serverName/tools/:toolName',
    );
    await expect(
      route.handler(
        req({
          params: { providerId: 'agency', serverName: 'Azure', toolName: 'read' },
          body: { enabled: 'no' },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mcp.setToolEnabled).not.toHaveBeenCalled();
  });

  it('restarts an MCP server', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'post /mcp/providers/:providerId/servers/:serverName/restart',
    );
    const result = await route.handler(
      req({ params: { providerId: 'agency', serverName: 'Azure' } }),
    );
    expect(mcp.restartServer).toHaveBeenCalledWith('agency', 'Azure');
    expect(result.status).toBe(200);
  });
});
