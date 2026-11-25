import { z } from 'zod';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';
import type { SkillUsageRepo } from '../skill-usage/skill-usage-contract.js';
import type { SkillUsageConfig } from '../skill-usage/config.js';

export function createSkillUsageRoutes(deps: { usage: SkillUsageRepo; config: SkillUsageConfig }): Route[] {
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  const windowSchema = z.object({ from: day, to: day }).refine(({ from, to }) =>
    to > from && Date.parse(to) - Date.parse(from) <= 366 * 86400000);
  const windowFor = (query: Record<string, unknown>) => {
    if (query.from === undefined && query.to === undefined) return {};
    return { window: parseInput(windowSchema, { from: query.from, to: query.to }) };
  };
  return [
    {
      method: 'get', path: '/usage/skills',
      handler: (req) => {
        const filter = parseInput(z.object({ scope: z.enum(['feature', 'internal']).optional() }), req.query);
        return { status: 200, body: deps.usage.read({ scope: filter.scope ?? 'feature', ...windowFor(req.query) }, deps.config.maxEvents) };
      },
    },
    {
      method: 'get', path: '/features/:featureId/skill-usage',
      handler: (req) => ({
        status: 200,
        body: deps.usage.read({ scope: 'feature', featureId: req.params.featureId, ...windowFor(req.query) }, deps.config.maxEvents),
      }),
    },
  ];
}
