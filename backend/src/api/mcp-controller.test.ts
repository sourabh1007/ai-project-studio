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
    inspectServer: vi.fn(async () => ({
      name: 'a',
      spec: { command: 'a' },
      tools: [{ name: 'read', description: null, enabled: true }],
      toolDiscovery: { status: 'ok' as const, message: null, output: [] },
    })),
    serverStatus: vi.fn(async () => ({
      name: 'a',
      status: 'connected' as const,
      toolCount: 1,
      authRequired: false,
      authUrl: null,
      message: null,
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
  it('serves scoped native option suggestions without mutations and rejects missing optional implementations', async () => {
    const options = { command: 'agency config set --global --mcp', options: [], examples: [], cachedAt: null, stale: false };
    const mcp = serviceStub({ getServerOptions: vi.fn(async () => options) });
    const params = { providerId: 'agency', serverName: 'catalog:ado' };
    const signature = 'get /mcp/providers/:providerId/servers/:serverName/options';
    expect(await routeFor(createMcpRoutes({ mcp }), signature).handler(req({ params }))).toEqual({ status: 200, body: options });
    expect(mcp.getServerOptions).toHaveBeenCalledWith('agency', 'catalog:ado');
    await expect(routeFor(createMcpRoutes({ mcp: serviceStub() }), signature).handler(req({ params }))).rejects.toThrow(/not supported/);
  });
  it('authenticates the read-only bridge health endpoint without exposing its token', async () => {
    const handler = routeFor(createMcpRoutes({ mcp: serviceStub(), controlToken: 'secret' }), 'get /mcp/bridge-health').handler;
    expect(handler(req({ headers: { 'x-studio-control-token': 'secret' } }))).toEqual({
      status: 200, body: { status: 'ok', server: 'ai-project-studio' },
    });
    expect(() => handler(req())).toThrow(/Invalid Studio control token/);
    expect(() => handler(req({ headers: { 'x-studio-control-token': 'wrong' } }))).toThrow(/Invalid Studio control token/);
    expect(() => routeFor(createMcpRoutes({ mcp: serviceStub() }), 'get /mcp/bridge-health').handler(req()))
      .toThrow(/Invalid Studio control token/);
  });
  it('exposes the expected route table', () => {
    const routes = createMcpRoutes({ mcp: serviceStub() });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'get /mcp/providers/:providerId/servers/:serverName/options',
      'post /mcp/providers/:providerId/servers/:serverName/authentication',
      'get /mcp/providers/:providerId/servers/:serverName/authentication/:jobId',
      'delete /mcp/providers/:providerId/servers/:serverName/authentication/:jobId',
      'post /mcp/providers/:providerId/servers/:serverName/configure',
      'get /mcp/bridge-health',
      'get /mcp/providers',
      'get /mcp/providers/:providerId/servers',
      'get /mcp/providers/:providerId/servers/:serverName/status',
      'get /mcp/providers/:providerId/servers/:serverName/tools',
      'put /mcp/providers/:providerId/servers',
      'put /mcp/providers/:providerId/servers/:serverName/tools/:toolName',
      'delete /mcp/providers/:providerId/servers/:serverName',
      'put /mcp/providers/:providerId/servers/:serverName/enabled',
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

  it('starts, polls and cancels explicitly scoped authentication jobs', async () => {
      const job = { id: 'j', serverName: 'global-builtins:ado', status: 'pending' as const, message: 'pending', authUrl: null, deviceCode: null, expiresAt: 'later' };
      const mcp = serviceStub({
        startAuthentication: vi.fn(async () => job),
        authenticationStatus: vi.fn(async () => job),
        cancelAuthentication: vi.fn(async () => ({ ...job, status: 'cancelled' as const })),
      });
      const routes = createMcpRoutes({ mcp });
      const params = { providerId: 'agency', serverName: 'global-builtins:ado', jobId: 'j' };
      expect(await routeFor(routes, 'post /mcp/providers/:providerId/servers/:serverName/authentication').handler(req({ params })))
        .toEqual({ status: 202, body: job });
      expect(mcp.startAuthentication).toHaveBeenCalledWith('agency', 'global-builtins:ado');
      expect(await routeFor(routes, 'get /mcp/providers/:providerId/servers/:serverName/authentication/:jobId').handler(req({ params })))
        .toEqual({ status: 200, body: job });
      expect(mcp.authenticationStatus).toHaveBeenCalledWith('agency', 'global-builtins:ado', 'j');
      expect(await routeFor(routes, 'delete /mcp/providers/:providerId/servers/:serverName/authentication/:jobId').handler(req({ params })))
        .toEqual({ status: 200, body: { ...job, status: 'cancelled' } });
      expect(mcp.cancelAuthentication).toHaveBeenCalledWith('agency', 'global-builtins:ado', 'j');
      const unsupported = createMcpRoutes({ mcp: serviceStub() });
      for (const signature of [
        'post /mcp/providers/:providerId/servers/:serverName/authentication',
        'get /mcp/providers/:providerId/servers/:serverName/authentication/:jobId',
        'delete /mcp/providers/:providerId/servers/:serverName/authentication/:jobId',
      ]) await expect(routeFor(unsupported, signature).handler(req({ params }))).rejects.toThrow(/not supported/);
  });

  it('configures an opaque builtin id with exactly the validated argument string', async () => {
      const config = { providerId: 'agency', configPath: 'global', exists: true, servers: [] };
      const mcp = serviceStub({ configureBuiltin: vi.fn(async () => config) });
      const route = routeFor(createMcpRoutes({ mcp }), 'post /mcp/providers/:providerId/servers/:serverName/configure');
      const params = { providerId: 'agency', serverName: 'catalog:ado' };
      const body = { arguments: '--organization "name with spaces"' };
      expect(await route.handler(req({ params, body }))).toEqual({ status: 200, body: config });
      expect(mcp.configureBuiltin).toHaveBeenCalledWith('agency', 'catalog:ado', body);
      for (const body of [{}, { arguments: 1 }, { arguments: '\n' }, { arguments: '\r' }, { arguments: '\0' }, { arguments: 'x'.repeat(4097) }, { arguments: '', command: 'evil' }]) {
        await expect(route.handler(req({ params, body }))).rejects.toThrow(ValidationError);
      }
      const unavailable = routeFor(createMcpRoutes({ mcp: serviceStub() }), 'post /mcp/providers/:providerId/servers/:serverName/configure');
      await expect(unavailable.handler(req({ params, body: { arguments: '' } }))).rejects.toThrow(/not supported/);
  });

  it('removes and toggles servers through optional category operations', async () => {
      const config = { providerId: 'claude', configPath: 'config', exists: true, servers: [] };
      const mcp = serviceStub({
        removeServer: vi.fn(async () => config),
        setServerEnabled: vi.fn(async () => config),
      });
      const routes = createMcpRoutes({ mcp });
      const params = { providerId: 'claude', serverName: 'user:a' };
      expect(await routeFor(routes, 'delete /mcp/providers/:providerId/servers/:serverName').handler(req({ params })))
        .toEqual({ status: 200, body: config });
      expect(mcp.removeServer).toHaveBeenCalledWith('claude', 'user:a');
      expect(await routeFor(routes, 'put /mcp/providers/:providerId/servers/:serverName/enabled').handler(req({ params, body: { enabled: false } })))
        .toEqual({ status: 200, body: config });
      expect(mcp.setServerEnabled).toHaveBeenCalledWith('claude', 'user:a', false);
    });

  it('rejects absent optional operations and invalid toggle requests explicitly', async () => {
      const mcp = serviceStub();
      const routes = createMcpRoutes({ mcp });
      const params = { providerId: 'copilot', serverName: 'user:a' };
      await expect(routeFor(routes, 'delete /mcp/providers/:providerId/servers/:serverName').handler(req({ params })))
        .rejects.toThrow(/not supported/);
      const toggle = routeFor(routes, 'put /mcp/providers/:providerId/servers/:serverName/enabled');
      await expect(toggle.handler(req({ params, body: { enabled: false } }))).rejects.toThrow(/not supported/);
      await expect(toggle.handler(req({ params, body: { enabled: 'false' } }))).rejects.toBeInstanceOf(ValidationError);
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

  it('inspects a single server’s tools on demand', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'get /mcp/providers/:providerId/servers/:serverName/tools',
    );
    const result = await route.handler(
      req({ params: { providerId: 'agency', serverName: 'a' } }),
    );
    expect(mcp.inspectServer).toHaveBeenCalledWith('agency', 'a');
    expect(result.status).toBe(200);
  });

  it('reports a single server’s live status', async () => {
    const mcp = serviceStub();
    const route = routeFor(
      createMcpRoutes({ mcp }),
      'get /mcp/providers/:providerId/servers/:serverName/status',
    );
    const result = await route.handler(
      req({ params: { providerId: 'agency', serverName: 'a' } }),
    );
    expect(mcp.serverStatus).toHaveBeenCalledWith('agency', 'a');
    expect(result).toEqual({
      status: 200,
      body: {
        name: 'a',
        status: 'connected',
        toolCount: 1,
        authRequired: false,
        authUrl: null,
        message: null,
      },
    });
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
