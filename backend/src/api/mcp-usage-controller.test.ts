import { describe, it, expect, vi } from 'vitest';
import { createMcpUsageRoutes } from './mcp-usage-controller.js';
import { createClock } from '../kernel/clock.js';
import type { Route } from './http-contract.js';
import type { McpUsageRepo } from '../mcp-usage/mcp-usage-contract.js';

function routeMap(routes: Route[]): Map<string, Route> {
  return new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

function repo(): McpUsageRepo & { record: ReturnType<typeof vi.fn> } {
  return {
    record: vi.fn(),
    deleteByFeature: vi.fn(),
    deleteBySession: vi.fn(),
  };
}

const clock = createClock(() => Date.parse('2025-01-01T00:00:00.000Z'));

const body = {
  featureId: 'f1',
  sessionId: 's1',
  provider: 'copilot',
  server: 'filesystem',
  calls: 3,
  inputBytes: 100,
  outputBytes: 200,
  durationMs: 40,
};

describe('createMcpUsageRoutes', () => {
  it('records a measured usage slice', async () => {
    const mcpUsage = repo();
    const routes = routeMap(createMcpUsageRoutes({ mcpUsage, clock }));
    const res = await routes.get('post /mcp-usage')!.handler({
      params: {},
      query: {},
      body,
    });
    expect(res.status).toBe(202);
    expect(mcpUsage.record).toHaveBeenCalledWith({
      featureId: 'f1',
      sessionId: 's1',
      provider: 'copilot',
      server: 'filesystem',
      calls: 3,
      inputBytes: 100,
      outputBytes: 200,
      durationMs: 40,
      recordedAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('coerces a blank session id to null', async () => {
    const mcpUsage = repo();
    const routes = routeMap(createMcpUsageRoutes({ mcpUsage, clock }));
    await routes.get('post /mcp-usage')!.handler({
      params: {},
      query: {},
      body: { ...body, sessionId: '   ' },
    });
    expect(mcpUsage.record.mock.calls[0][0].sessionId).toBeNull();
  });

  it('enforces the control token when configured', async () => {
    const mcpUsage = repo();
    const routes = routeMap(
      createMcpUsageRoutes({ mcpUsage, clock, controlToken: 'secret' }),
    );
    await expect(
      routes.get('post /mcp-usage')!.handler({ params: {}, query: {}, body }),
    ).rejects.toThrow(/control token/);
    const res = await routes.get('post /mcp-usage')!.handler({
      params: {},
      query: {},
      headers: { 'x-studio-control-token': 'secret' },
      body,
    });
    expect(res.status).toBe(202);
  });

  it('rejects a missing feature id and negative counts', async () => {
    const mcpUsage = repo();
    const routes = routeMap(createMcpUsageRoutes({ mcpUsage, clock }));
    await expect(
      routes.get('post /mcp-usage')!.handler({
        params: {},
        query: {},
        body: { ...body, featureId: '' },
      }),
    ).rejects.toThrow(/featureId/);
    await expect(
      routes.get('post /mcp-usage')!.handler({
        params: {},
        query: {},
        body: { ...body, calls: -1 },
      }),
    ).rejects.toThrow(/calls/);
    expect(mcpUsage.record).not.toHaveBeenCalled();
  });

  it('treats a missing body as empty and rejects it', async () => {
    const mcpUsage = repo();
    const routes = routeMap(createMcpUsageRoutes({ mcpUsage, clock }));
    await expect(
      routes.get('post /mcp-usage')!.handler({ params: {}, query: {} }),
    ).rejects.toThrow(/featureId/);
    expect(mcpUsage.record).not.toHaveBeenCalled();
  });
});
