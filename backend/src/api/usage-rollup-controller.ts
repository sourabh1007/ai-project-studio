import type { MetaUsageRepo } from '../meta/meta-usage-contract.js';
import type { UsageRollupService } from '../usage-rollup/usage-rollup-service.js';
import { parseGranularity } from '../usage-rollup/usage-rollup-service.js';
import type { UsageRollup } from '../usage-rollup/usage-rollup-contract.js';
import { isProviderExposed } from '../provider/default-provider-selection.js';
import type { Route } from './http-contract.js';

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
      handler: (req) => ({
        status: 200,
        body: filterExposure(
          deps.rollups.workspace(parseGranularity(req.query.granularity)),
        ),
      }),
    },
    {
      method: 'get',
      path: '/usage/ide/rollup',
      handler: (req) => ({
        status: 200,
        body: filterExposure(
          deps.rollups.ide(parseGranularity(req.query.granularity)),
        ),
      }),
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
      handler: (req) => ({
        status: 200,
        body: filterExposure(
          deps.rollups.feature(
            req.params.featureId,
            parseGranularity(req.query.granularity),
          ),
        ),
      }),
    },
  ];
}
