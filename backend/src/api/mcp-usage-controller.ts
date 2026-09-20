import type { Route } from './http-contract.js';
import type { Clock } from '../kernel/clock.js';
import type { McpUsageRepo } from '../mcp-usage/mcp-usage-contract.js';
import { ValidationError } from '../kernel/error-types.js';

export const STUDIO_CONTROL_TOKEN_HEADER = 'x-studio-control-token';

export interface McpUsageControllerDeps {
  mcpUsage: McpUsageRepo;
  clock: Clock;
  /** Per-launch token; only the Studio-spawned proxy may report usage. */
  controlToken?: string;
}

function assertControlToken(
  req: Parameters<Route['handler']>[0],
  expected: string | undefined,
): void {
  if (expected === undefined) {
    return;
  }
  if (req.headers?.[STUDIO_CONTROL_TOKEN_HEADER] !== expected) {
    throw new ValidationError('Invalid Studio control token');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required`);
  }
  return value.trim();
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative number`);
  }
  return Math.floor(value);
}

/**
 * Control route the MCP launch proxy posts to when a wrapped server exits. It
 * carries real, measured per-server transport I/O (calls/bytes/latency) tagged
 * with the feature/session inherited from the CLI. Guarded by the per-launch
 * control token so only the Studio-spawned proxy can write usage.
 */
export function createMcpUsageRoutes(deps: McpUsageControllerDeps): Route[] {
  return [
    {
      method: 'post',
      path: '/mcp-usage',
      handler: async (req) => {
        assertControlToken(req, deps.controlToken);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const sessionId =
          typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
            ? body.sessionId.trim()
            : null;
        deps.mcpUsage.record({
          featureId: requireString(body.featureId, 'featureId'),
          sessionId,
          provider: requireString(body.provider, 'provider'),
          server: requireString(body.server, 'server'),
          calls: nonNegativeInt(body.calls, 'calls'),
          inputBytes: nonNegativeInt(body.inputBytes, 'inputBytes'),
          outputBytes: nonNegativeInt(body.outputBytes, 'outputBytes'),
          durationMs: nonNegativeInt(body.durationMs, 'durationMs'),
          recordedAt: deps.clock.now().toISOString(),
        });
        return { status: 202, body: { ok: true } };
      },
    },
  ];
}
