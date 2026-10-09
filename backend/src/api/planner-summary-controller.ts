import { z } from 'zod';
import type { PlannerSummarizer } from '../planner-summary/planner-summary-contract.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const summarySchema = z.object({
  scope: z.enum(['day', 'month', 'year']),
  date: z.string().min(1),
  prompt: z.string().optional(),
});

export interface PlannerSummaryControllerDeps {
  plannerSummarizer: PlannerSummarizer;
}

/** Route for generating an on-demand AI summary of a scope of planner tasks. */
export function createPlannerSummaryRoutes(
  deps: PlannerSummaryControllerDeps,
): Route[] {
  return [
    {
      method: 'post',
      path: '/planner/summary',
      handler: async (req) => {
        const input = parseInput(summarySchema, req.body);
        return {
          status: 200,
          body: await deps.plannerSummarizer.summarize({
            scope: input.scope,
            date: input.date,
            prompt: input.prompt ?? '',
            signal: req.signal,
          }),
        };
      },
    },
  ];
}
