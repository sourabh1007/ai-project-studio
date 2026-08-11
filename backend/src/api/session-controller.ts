import { z } from 'zod';
import type { Logger } from '../kernel/logger.js';
import type { SessionLauncher } from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { WorkspaceAdmin } from '../workspace/workspace-admin-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';
import type { Session } from '../session/session-contract.js';
import type { CopilotHistoryReader } from '../copilot-history/copilot-history-contract.js';

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
  history?: CopilotHistoryReader;
  logger: Logger;
}

function includeInternal(query: string | undefined): boolean {
  return query === 'true' || query === '1';
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function enrichWorkTitles(
  sessions: Session[],
  history: CopilotHistoryReader | undefined,
): Session[] {
  if (!history || sessions.length === 0) {
    return sessions;
  }
  const historyById = new Map(
    history.read(sessions.map((session) => session.id)).map((item) => [
      item.sessionId,
      item,
    ]),
  );
  return sessions.map((session) => {
    const item = historyById.get(session.id);
    const workTitle = firstNonEmpty(item?.firstUserMessage, item?.summary);
    return workTitle ? { ...session, workTitle } : session;
  });
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
      handler: (req) => {
        const sessions = includeInternal(req.query.includeInternal)
          ? deps.sessions.listByFeatureAll(req.params.featureId)
          : deps.sessions.listByFeature(req.params.featureId);
        return {
          status: 200,
          body: enrichWorkTitles(sessions, deps.history),
        };
      },
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
