import { z } from 'zod';
import type { FeatureTasksService } from '../feature-tasks/feature-tasks-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const addTaskSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
});

export interface FeatureTasksControllerDeps {
  tasks: FeatureTasksService;
}

/**
 * Routes for the task-plan skill's feature checklist: list, AI-generate,
 * add a manual task, toggle done, and remove. More specific paths precede
 * parameterized ones so `/tasks/generate` is not swallowed by `/tasks`.
 */
export function createFeatureTasksRoutes(
  deps: FeatureTasksControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/tasks',
      handler: (req) => ({
        status: 200,
        body: deps.tasks.listForFeature(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/tasks/generate',
      handler: async (req) => ({
        status: 201,
        body: await deps.tasks.generate(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/tasks',
      handler: (req) => {
        const input = parseInput(addTaskSchema, req.body);
        return {
          status: 201,
          body: deps.tasks.addTask({
            featureId: req.params.featureId,
            ...input,
          }),
        };
      },
    },
    {
      method: 'put',
      path: '/tasks/:taskId',
      handler: (req) => ({
        status: 200,
        body: deps.tasks.toggle(req.params.taskId),
      }),
    },
    {
      method: 'delete',
      path: '/tasks/:taskId',
      handler: (req) => {
        deps.tasks.removeTask(req.params.taskId);
        return { status: 200, body: { id: req.params.taskId } };
      },
    },
  ];
}
