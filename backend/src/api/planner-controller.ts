import { z } from 'zod';
import type { PlannerService } from '../planner/planner-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const prioritySchema = z.enum(['p0', 'p1', 'p2', 'p3']);
const kindSchema = z.enum(['task', 'pr']);
const statusSchema = z.enum(['open', 'done']);
const launchKindSchema = z.enum(['session', 'agent', 'review']);

const createTaskSchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional(),
  priority: prioritySchema.optional(),
  kind: kindSchema.optional(),
  prUrl: z.string().optional(),
  date: z.string().optional(),
  repoId: z.string().nullable().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  priority: prioritySchema.optional(),
  kind: kindSchema.optional(),
  prUrl: z.string().optional(),
  date: z.string().optional(),
  status: statusSchema.optional(),
  repoId: z.string().nullable().optional(),
  launchKind: launchKindSchema.nullable().optional(),
  featureId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  launchLabel: z.string().nullable().optional(),
  backloggedAt: z.string().nullable().optional(),
});

export interface PlannerControllerDeps {
  planner: PlannerService;
}

/** Routes for the standalone Planner checklist: list, create, update, delete. */
export function createPlannerRoutes(deps: PlannerControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/planner/tasks',
      handler: () => ({ status: 200, body: deps.planner.list() }),
    },
    {
      method: 'post',
      path: '/planner/tasks',
      handler: (req) => {
        const input = parseInput(createTaskSchema, req.body);
        return { status: 201, body: deps.planner.create(input) };
      },
    },
    {
      method: 'put',
      path: '/planner/tasks/:taskId',
      handler: (req) => {
        const input = parseInput(updateTaskSchema, req.body);
        return {
          status: 200,
          body: deps.planner.update(req.params.taskId, input),
        };
      },
    },
    {
      method: 'delete',
      path: '/planner/tasks/:taskId',
      handler: (req) => {
        deps.planner.remove(req.params.taskId);
        return { status: 200, body: { id: req.params.taskId } };
      },
    },
  ];
}
