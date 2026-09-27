import { z } from 'zod';
import type { McpService } from '../mcp/mcp-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';
import { ValidationError } from '../kernel/error-types.js';

const putServerSchema = z.object({
  name: z.string().min(1),
  spec: z.record(z.string(), z.unknown()),
});

const setToolSchema = z.object({
  enabled: z.boolean(),
});

export interface McpControllerDeps {
  mcp: McpService;
  controlToken?: string;
}

/**
 * Routes for MCP server management: list providers that expose MCP, read a
 * provider's configured servers, and add/update a single server entry.
 */
export function createMcpRoutes(deps: McpControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/mcp/providers/:providerId/servers/:serverName/options',
      handler: async (req) => {
        if (!deps.mcp.getServerOptions) throw new ValidationError('Native option suggestions are not supported.');
        return { status: 200, body: await deps.mcp.getServerOptions(req.params.providerId, req.params.serverName) };
      },
    },
    {
      method: 'post',
      path: '/mcp/providers/:providerId/servers/:serverName/authentication',
      handler: async (req) => {
        if (!deps.mcp.startAuthentication) throw new ValidationError('Native authentication continuation is not supported.');
        return { status: 202, body: await deps.mcp.startAuthentication(req.params.providerId, req.params.serverName) };
      },
    },
    {
      method: 'get',
      path: '/mcp/providers/:providerId/servers/:serverName/authentication/:jobId',
      handler: async (req) => {
        if (!deps.mcp.authenticationStatus) throw new ValidationError('Native authentication jobs are not supported.');
        return { status: 200, body: await deps.mcp.authenticationStatus(req.params.providerId, req.params.serverName, req.params.jobId) };
      },
    },
    {
      method: 'delete',
      path: '/mcp/providers/:providerId/servers/:serverName/authentication/:jobId',
      handler: async (req) => {
        if (!deps.mcp.cancelAuthentication) throw new ValidationError('Native authentication jobs are not supported.');
        return { status: 200, body: await deps.mcp.cancelAuthentication(req.params.providerId, req.params.serverName, req.params.jobId) };
      },
    },
    {
      method: 'post',
      path: '/mcp/providers/:providerId/servers/:serverName/configure',
      handler: async (req) => {
        const input = parseInput(z.object({ arguments: z.string().max(4096).regex(/^[^\r\n\0]*$/) }).strict(), req.body);
        if (!deps.mcp.configureBuiltin) throw new ValidationError('Built-in configuration is not supported by this MCP manager.');
        return {
          status: 200,
          body: await deps.mcp.configureBuiltin(req.params.providerId, req.params.serverName, input),
        };
      },
    },
    {
      method: 'get',
      path: '/mcp/bridge-health',
      handler: (req) => {
        if (!deps.controlToken || req.headers?.['x-studio-control-token'] !== deps.controlToken) {
          throw new ValidationError('Invalid Studio control token');
        }
        return { status: 200, body: { status: 'ok', server: 'ai-project-studio' } };
      },
    },
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
      method: 'get',
      path: '/mcp/providers/:providerId/servers/:serverName/status',
      handler: async (req) => ({
        status: 200,
        body: await deps.mcp.serverStatus(
          req.params.providerId,
          req.params.serverName,
        ),
      }),
    },
    {
      method: 'get',
      path: '/mcp/providers/:providerId/servers/:serverName/tools',
      handler: async (req) => ({
        status: 200,
        body: await deps.mcp.inspectServer(
          req.params.providerId,
          req.params.serverName,
        ),
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
    {
      method: 'put',
      path: '/mcp/providers/:providerId/servers/:serverName/tools/:toolName',
      handler: async (req) => {
        const input = parseInput(setToolSchema, req.body);
        return {
          status: 200,
          body: await deps.mcp.setToolEnabled(req.params.providerId, {
            serverName: req.params.serverName,
            toolName: req.params.toolName,
            enabled: input.enabled,
          }),
        };
      },
    },
    {
      method: 'delete',
      path: '/mcp/providers/:providerId/servers/:serverName',
      handler: async (req) => {
        if (!deps.mcp.removeServer) throw new ValidationError('Removing servers is not supported by this MCP manager.');
        return {
          status: 200,
          body: await deps.mcp.removeServer(req.params.providerId, req.params.serverName),
        };
      },
    },
    {
      method: 'put',
      path: '/mcp/providers/:providerId/servers/:serverName/enabled',
      handler: async (req) => {
        const input = parseInput(setToolSchema, req.body);
        if (!deps.mcp.setServerEnabled) throw new ValidationError('Server enable/disable is not supported by this MCP manager.');
        return {
          status: 200,
          body: await deps.mcp.setServerEnabled(req.params.providerId, req.params.serverName, input.enabled),
        };
      },
    },
    {
      method: 'post',
      path: '/mcp/providers/:providerId/servers/:serverName/restart',
      handler: async (req) => ({
        status: 200,
        body: await deps.mcp.restartServer(
          req.params.providerId,
          req.params.serverName,
        ),
      }),
    },
  ];
}
