import { z } from 'zod';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';
import type { SkillUsageRepo } from '../skill-usage/skill-usage-contract.js';
import type { SkillUsageConfig } from '../skill-usage/config.js';

export function createSkillUsageRoutes(deps: { usage: SkillUsageRepo; config: SkillUsageConfig }): Route[] {
  return [
    {
      method: 'get', path: '/usage/skills',
      handler: (req) => {
        const filter = parseInput(z.object({ scope: z.enum(['feature', 'internal']).optional() }), req.query);
        return { status: 200, body: deps.usage.read({ scope: filter.scope ?? 'feature' }, deps.config.maxEvents) };
      },
    },
    {
      method: 'get', path: '/features/:featureId/skill-usage',
      handler: (req) => ({
        status: 200,
        body: deps.usage.read({ scope: 'feature', featureId: req.params.featureId }, deps.config.maxEvents),
      }),
    },
  ];
}
