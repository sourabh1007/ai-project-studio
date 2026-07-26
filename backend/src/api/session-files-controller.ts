import type { SessionFilesStore } from '../session-files/session-files-contract.js';
import type { Route } from './http-contract.js';

export interface SessionFilesControllerDeps {
  sessionFiles: Pick<SessionFilesStore, 'list'>;
}

/** Route exposing the files a session created or edited. */
export function createSessionFilesRoutes(
  deps: SessionFilesControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/sessions/:sessionId/files',
      handler: (req) => ({
        status: 200,
        body: deps.sessionFiles.list(req.params.sessionId),
      }),
    },
  ];
}
