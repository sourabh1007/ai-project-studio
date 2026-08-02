import { z } from 'zod';
import type { Logger } from '../kernel/logger.js';
import type { SessionLauncher } from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { WorkspaceAdmin } from '../workspace/workspace-admin-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const startSessionSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1),
  kind: z.enum(['dev', 'meta']).optional(),
  cwd: z.string().min(1).optional(),
});

const renameSessionSchema = z.object({
  name: z.string().max(120).nullable(),
});

export interface SessionControllerDeps {
  launcher: SessionLauncher;
  sessions: SessionRepo;
  admin: WorkspaceAdmin;
  logger: Logger;
}

/** Routes for starting sessions and reading them back. */
export function createSessionRoutes(deps: SessionControllerDeps): Route[] {
  return [
    {
      method: 'post',
      path: '/features/:featureId/sessions',
      handler: async (req) => {
        const input = parseInput(startSessionSchema, req.body);
        const launched = await deps.launcher.start({
          featureId: req.params.featureId,
          ...input,
          prompt: input.prompt,
        });
        launched.completion.catch((error) =>
          deps.logger.error('Session run failed', error),
        );
        return { status: 202, body: launched.session };
      },
    },
    {
      method: 'get',
      path: '/features/:featureId/sessions',
      handler: (req) => ({
        status: 200,
        body: deps.sessions.listByFeature(req.params.featureId),
      }),
    },
    {
      method: 'get',
      path: '/sessions/:id',
      handler: (req) => {
        const session = deps.sessions.get(req.params.id);
        if (!session) {
          return { status: 404, body: { error: { kind: 'not_found', message: 'Unknown session' } } };
        }
        return { status: 200, body: session };
      },
    },
    {
      method: 'put',
      path: '/sessions/:id',
      handler: (req) => {
        const input = parseInput(renameSessionSchema, req.body);
        const session = deps.admin.renameSession(req.params.id, input.name);
        return { status: 200, body: session };
      },
    },
    {
      method: 'delete',
      path: '/sessions/:id',
      handler: async (req) => {
        await deps.admin.deleteSession(req.params.id);
        return { status: 200, body: { id: req.params.id } };
      },
    },
  ];
}
