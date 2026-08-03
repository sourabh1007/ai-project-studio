import { z } from 'zod';
import type { FeatureTreeService } from '../feature-tree/feature-tree-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const createGroupSchema = z.object({
  parentGroupId: z.string().min(1).nullable().optional(),
  kind: z.enum(['subcategory', 'pr']),
  name: z.string(),
  prNumber: z.number().int().positive().nullable().optional(),
  prUrl: z.string().min(1).nullable().optional(),
});

const renameGroupSchema = z.object({
  name: z.string(),
});

const moveNodeSchema = z.object({
  type: z.enum(['session', 'group']),
  id: z.string().min(1),
  targetFeatureId: z.string().min(1),
  targetParentGroupId: z.string().min(1).nullable(),
  targetIndex: z.number().int().min(0),
});

export interface FeatureTreeControllerDeps {
  tree: FeatureTreeService;
}

/**
 * Routes for organizing a feature's work tree: list/create/rename/delete
 * groups (subcategories and PR containers) and move any node (session or
 * group) to a new container and position via drag-and-drop.
 */
export function createFeatureTreeRoutes(
  deps: FeatureTreeControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/groups',
      handler: (req) => ({
        status: 200,
        body: deps.tree.listGroups(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/groups',
      handler: (req) => {
        const input = parseInput(createGroupSchema, req.body);
        return {
          status: 201,
          body: deps.tree.createGroup({
            featureId: req.params.featureId,
            ...input,
          }),
        };
      },
    },
    {
      method: 'put',
      path: '/groups/:groupId',
      handler: (req) => {
        const input = parseInput(renameGroupSchema, req.body);
        return {
          status: 200,
          body: deps.tree.renameGroup(req.params.groupId, input.name),
        };
      },
    },
    {
      method: 'delete',
      path: '/groups/:groupId',
      handler: (req) => {
        deps.tree.deleteGroup(req.params.groupId);
        return { status: 200, body: { id: req.params.groupId } };
      },
    },
    {
      method: 'post',
      path: '/tree/move',
      handler: (req) => {
        const input = parseInput(moveNodeSchema, req.body);
        deps.tree.moveNode(input);
        return { status: 200, body: { moved: true } };
      },
    },
  ];
}
