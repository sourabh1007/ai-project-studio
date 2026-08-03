import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';
import type { StoredUsage, UsageRepo } from '../usage/usage-repo-port.js';

/** Membership sources needed to expand a feature or repository into sessions. */
export interface UsageDetailSessionLister {
  listByFeature(featureId: string): Session[];
}

export interface UsageDetailFeatureLister {
  list(): Feature[];
}

export interface UsageDetailDeps {
  usage: Pick<UsageRepo, 'listBySession'>;
  sessions: UsageDetailSessionLister;
  features: UsageDetailFeatureLister;
}

/**
 * Per-turn usage detail: the granular "how every credit and token was spent"
 * view that backs the UI drill-down. Rollups (feature-analytics) group usage;
 * this exposes each individual usage event (one per turn/request) at the
 * session, feature, and repository scopes.
 */
export interface UsageDetailService {
  forSession(sessionId: string): StoredUsage[];
  forFeature(featureId: string): StoredUsage[];
  forRepo(repoId: string): StoredUsage[];
}

/**
 * A lexically sortable key that orders usage events chronologically, then by
 * session and turn so the breakdown reads as a stable timeline of spend. Rows
 * whose start time cannot be parsed sort last via a max sentinel.
 */
function sortKey(e: StoredUsage): string {
  const parsed = Date.parse(e.startedAt);
  const time = Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
  return [
    String(time).padStart(16, '0'),
    e.sessionId,
    String(e.turnIndex).padStart(10, '0'),
  ].join(':');
}

function compareUsage(a: StoredUsage, b: StoredUsage): number {
  return sortKey(a).localeCompare(sortKey(b));
}

export function createUsageDetailService(
  deps: UsageDetailDeps,
): UsageDetailService {
  const { usage, sessions, features } = deps;

  const forFeatureId = (featureId: string): StoredUsage[] =>
    sessions
      .listByFeature(featureId)
      .flatMap((session) => usage.listBySession(session.id));

  return {
    forSession(sessionId) {
      return usage.listBySession(sessionId);
    },
    forFeature(featureId) {
      return forFeatureId(featureId).sort(compareUsage);
    },
    forRepo(repoId) {
      return features
        .list()
        .filter((feature) => feature.repoId === repoId)
        .flatMap((feature) => forFeatureId(feature.id))
        .sort(compareUsage);
    },
  };
}
