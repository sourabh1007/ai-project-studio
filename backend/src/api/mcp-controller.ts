import { z } from 'zod';
import type { McpService } from '../mcp/mcp-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const putServerSchema = z.object({
  name: z.string().min(1),
  spec: z.record(z.string(), z.unknown()),
});

export interface McpControllerDeps {
  mcp: McpService;
}

/**
 * Routes for MCP server management: list providers that expose MCP, read a
 * provider's configured servers, and add/update a single server entry.
 */
export function createMcpRoutes(deps: McpControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/mcp/providers',
      handler: () => ({ status: 200, body: deps.mcp.listProviders() }),
    },
    {
      method: 'get',
      path: '/mcp/providers/:providerId/servers',
      handler: async (req) => ({
        status: 200,
        body: await deps.mcp.getServers(req.params.providerId),
      }),
    },
    {
      method: 'put',
      path: '/mcp/providers/:providerId/servers',
      handler: async (req) => {
        const input = parseInput(putServerSchema, req.body);
        return {
          status: 200,
          body: await deps.mcp.putServer(req.params.providerId, input),
        };
      },
    },
  ];
}
