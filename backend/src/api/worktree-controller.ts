import { ValidationError } from '../kernel/error-types.js';
import type { WorktreeService } from '../worktrees/worktree-contract.js';
import type { Route } from './http-contract.js';

export interface WorktreeControllerDeps {
  worktrees: WorktreeService;
}

/** Reads and validates the `path` of the worktree to remove from a body. */
function assertPath(body: unknown): string {
  const path = (body as { path?: unknown })?.path;
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new ValidationError('A non-empty worktree "path" is required.');
  }
  return path;
}

/** Routes to list and delete the git worktrees the app provisioned for reviews. */
export function createWorktreeRoutes(deps: WorktreeControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/worktrees',
      handler: async () => ({ status: 200, body: await deps.worktrees.list() }),
    },
    {
      method: 'post',
      path: '/worktrees/remove',
      handler: async (req) => {
        await deps.worktrees.remove(assertPath(req.body));
        return { status: 200, body: { removed: true } };
      },
    },
  ];
}
