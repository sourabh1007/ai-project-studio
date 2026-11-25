import type { Route } from './http-contract.js';
import type { Clock } from '../kernel/clock.js';
import type { McpUsageRepo } from '../mcp-usage/mcp-usage-contract.js';
import { ValidationError } from '../kernel/error-types.js';
import { z } from 'zod';
import { isProviderExposed } from '../provider/default-provider-selection.js';

export const STUDIO_CONTROL_TOKEN_HEADER = 'x-studio-control-token';

export interface McpUsageControllerDeps {
  microsoftSignedIn?: () => boolean;
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
    ...(deps.mcpUsage.observedHistory ? [{
      method: 'get' as const, path: '/mcp-usage/history',
      handler: ((req) => {
        const parsed = z.object({
          provider: z.string().min(1).max(200), server: z.string().min(1).max(512),
          scope: z.enum(['feature', 'internal']), featureId: z.string().min(1).max(512).optional(),
          from: z.string().datetime(), to: z.string().datetime(),
        }).strict().refine((value) => Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86400000).safeParse(req.query);
        if (!parsed.success) return { status: 400, body: { error: 'Expected exact provider/server/scope and a UTC window of at most 31 days.' } };
        if (!isProviderExposed(parsed.data.provider, deps.microsoftSignedIn?.() ?? false))
          return { status: 404, body: { error: 'Provider telemetry unavailable.' } };
        const rows = deps.mcpUsage.observedHistory!({ ...parsed.data,
          from: new Date(parsed.data.from).toISOString(), to: new Date(parsed.data.to).toISOString() });
        return { status: 200, body: { items: rows.slice(0, 500), limited: rows.length > 500 } };
      }) satisfies Route['handler'],
    }] : []),
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
