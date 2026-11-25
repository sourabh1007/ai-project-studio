import { z } from 'zod';
import type { PromptUsageRepo } from '../meta/prompt-usage-contract.js';
import type { Route } from './http-contract.js';

export function createPromptUsageRoutes(deps: {
  usage: PromptUsageRepo; maxEvents: number; microsoftSignedIn?: () => boolean;
}): Route[] {
  const query = z.object({
    from: z.string().datetime(), to: z.string().datetime(),
    promptRef: z.string().min(1).max(200).optional(),
  }).strict().refine((value) => Date.parse(value.to) > Date.parse(value.from) &&
    Date.parse(value.to) - Date.parse(value.from) <= 366 * 86400000);
  return [{
    method: 'get', path: '/prompt-usage',
    handler(req) {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) return { status: 400, body: { error: { kind: 'validation', message: 'Invalid prompt usage query' } } };
      return { status: 200, body: deps.usage.read({
        ...parsed.data, from: new Date(parsed.data.from).toISOString(), to: new Date(parsed.data.to).toISOString(),
        ...(deps.microsoftSignedIn?.() === false ? { excludeProviderId: 'agency' } : {}),
      }, deps.maxEvents) };
    },
  }];
}
