import { z } from 'zod';
import type { FeatureService } from '../feature/feature-service.js';
import type { WorkspaceAdmin } from '../workspace/workspace-admin-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const createFeatureSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});

const renameFeatureSchema = z.object({
  name: z.string().min(1),
});

export interface FeatureControllerDeps {
  features: FeatureService;
  admin: WorkspaceAdmin;
}

/** Routes for creating, listing, reading, renaming and deleting features. */
export function createFeatureRoutes(deps: FeatureControllerDeps): Route[] {
  return [
    {
      method: 'post',
      path: '/features',
      handler: (req) => {
        const input = parseInput(createFeatureSchema, req.body);
        return { status: 201, body: deps.features.create(input) };
      },
    },
    {
      method: 'get',
      path: '/features',
      handler: () => ({ status: 200, body: deps.features.list() }),
    },
    {
      method: 'get',
      path: '/features/:id',
      handler: (req) => ({
        status: 200,
        body: deps.features.get(req.params.id),
      }),
    },
    {
      method: 'put',
      path: '/features/:id',
      handler: (req) => {
        const input = parseInput(renameFeatureSchema, req.body);
        return {
          status: 200,
          body: deps.admin.renameFeature(req.params.id, input.name),
        };
      },
    },
    {
      method: 'delete',
      path: '/features/:id',
      handler: async (req) => {
        await deps.admin.deleteFeature(req.params.id);
        return { status: 200, body: { id: req.params.id } };
      },
    },
  ];
}
