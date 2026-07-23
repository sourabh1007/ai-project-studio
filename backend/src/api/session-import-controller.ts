import { z } from 'zod';
import type { SessionImportService } from '../session-import/session-import-contract.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const importSessionSchema = z.object({
  provider: z.string().min(1),
  externalId: z.string().min(1),
});

export interface SessionImportControllerDeps {
  imports: SessionImportService;
}

/** Routes for listing importable provider sessions and importing one. */
export function createSessionImportRoutes(
  deps: SessionImportControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/importable-sessions',
      handler: () => ({ status: 200, body: deps.imports.listImportable() }),
    },
    {
      method: 'post',
      path: '/features/:featureId/import-session',
      handler: (req) => {
        const input = parseInput(importSessionSchema, req.body);
        const session = deps.imports.import({
          featureId: req.params.featureId,
          provider: input.provider,
          externalId: input.externalId,
        });
        return { status: 201, body: session };
      },
    },
  ];
}
