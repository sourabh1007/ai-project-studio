import { ValidationError } from '../kernel/error-types.js';
import type { NewTaskService } from '../new-task/new-task-contract.js';
import type { Route } from './http-contract.js';

export interface NewTaskControllerDeps {
  newTask: NewTaskService;
}

/** Validate and extract the `{ problem, context }` of an inputs request. */
function assertInputs(body: unknown): { problem: string; context: string } {
  const problem = (body as { problem?: unknown })?.problem;
  if (typeof problem !== 'string' || problem.trim().length === 0) {
    throw new ValidationError('A non-empty "problem" is required.');
  }
  const rawContext = (body as { context?: unknown })?.context;
  if (rawContext !== undefined && typeof rawContext !== 'string') {
    throw new ValidationError('"context" must be a string when provided.');
  }
  return { problem, context: typeof rawContext === 'string' ? rawContext : '' };
}

/**
 * Routes for the New Task agent: read the current run and capture the problem +
 * context. Producing the reviewable plan and implementing the approved plan are
 * long-lived streaming operations mounted separately (each streams NDJSON
 * progress over one request), so they are not plain request/response routes.
 */
export function createNewTaskRoutes(deps: NewTaskControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/new-task/:attachmentId',
      handler: (req) => ({
        status: 200,
        body: { run: deps.newTask.get(req.params.attachmentId) },
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/new-task/:attachmentId/inputs',
      handler: (req) => {
        const { problem, context } = assertInputs(req.body);
        return {
          status: 200,
          body: deps.newTask.saveInputs(
            req.params.attachmentId,
            req.params.featureId,
            { problem, context },
          ),
        };
      },
    },
    {
      method: 'get',
      path: '/features/:featureId/new-task/:attachmentId/file-diff',
      handler: async (req) => {
        const path = req.query.path;
        if (typeof path !== 'string' || path.trim().length === 0) {
          throw new ValidationError('A non-empty "path" query is required.');
        }
        return {
          status: 200,
          body: await deps.newTask.fileDiff(req.params.attachmentId, path),
        };
      },
    },
  ];
}
