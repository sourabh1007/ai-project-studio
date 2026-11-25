import type { MetaUsageRepo } from '../meta/meta-usage-contract.js';
import type { UsageRollupService } from '../usage-rollup/usage-rollup-service.js';
import { parseGranularity } from '../usage-rollup/usage-rollup-service.js';
import type { UsageRollup } from '../usage-rollup/usage-rollup-contract.js';
import { isProviderExposed } from '../provider/default-provider-selection.js';
import type { Route } from './http-contract.js';
import { z } from 'zod';

export interface UsageRollupControllerDeps {
  rollups: UsageRollupService;
  metaUsage: Pick<MetaUsageRepo, 'listRecent'>;
  /** Upper bound on rows returned by the IDE activity feed. */
  activityLimit: number;
  /**
   * True when signed in with a Microsoft identity. When false, Microsoft-only
   * providers (Agency) are stripped from the per-provider breakdown so the
   * usage view shows no trace of Agency for non-Microsoft users.
   */
  microsoftSignedIn: () => boolean;
}

/**
 * Consolidated usage rollups (day/week/month/year) for the workspace, the IDE's
 * own metasession overhead, and individual features — plus a recent IDE activity
 * feed that explains which model burned credits and why. Metasession usage is
 * folded into every scope so totals reconcile with the plan budget.
 */
export function createUsageRollupRoutes(
  deps: UsageRollupControllerDeps,
): Route[] {
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  const windowSchema = z.object({ from: day, to: day }).refine(({ from, to }) =>
    to > from && Date.parse(to) - Date.parse(from) <= 366 * 86400000);
  const windowFor = (query: Record<string, unknown>) => {
    if (query.from === undefined && query.to === undefined) return undefined;
    return windowSchema.parse({ from: query.from, to: query.to });
  };
  const read = (query: Record<string, unknown>, load: (window?: { from: string; to: string }) => UsageRollup) => {
    const parsed = windowSchema.safeParse({ from: query.from, to: query.to });
    if ((query.from !== undefined || query.to !== undefined) && !parsed.success)
      return { status: 400, body: { error: 'Expected valid UTC from/to dates, exclusive to, at most 366 days.' } };
    return { status: 200, body: filterExposure(load(windowFor(query))) };
  };
  const filterExposure = (rollup: UsageRollup): UsageRollup => {
    if (deps.microsoftSignedIn()) {
      return rollup;
    }
    return {
      ...rollup,
      byProvider: rollup.byProvider.filter((p) =>
        isProviderExposed(p.provider, false),
      ),
    };
  };
  return [
    {
      method: 'get',
      path: '/usage/rollup',
      handler: (req) => read(req.query, (window) =>
        deps.rollups.workspace(parseGranularity(req.query.granularity), window)),
    },
    {
      method: 'get',
      path: '/usage/ide/rollup',
      handler: (req) => read(req.query, (window) =>
        deps.rollups.ide(parseGranularity(req.query.granularity), window)),
    },
    {
      method: 'get',
      path: '/usage/ide/activity',
      handler: () => ({
        status: 200,
        body: { records: deps.metaUsage.listRecent(deps.activityLimit) },
      }),
    },
    {
      method: 'get',
      path: '/features/:featureId/usage/rollup',
      handler: (req) => read(req.query, (window) =>
        deps.rollups.feature(req.params.featureId, parseGranularity(req.query.granularity), window)),
    },
  ];
}
