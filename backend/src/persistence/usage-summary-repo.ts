import type { DatabaseSync } from 'node:sqlite';
import type { AggregationConfig } from '../aggregation/config.js';
import type {
  UsageSummaryFeatureRow,
  UsageSummaryGroupRow,
  UsageSummaryReader,
  UsageSummarySessionRow,
  UsageSummaryUsageRow,
} from '../usage-summary/usage-summary-contract.js';
import { TOTALS_COLUMNS, toTotals, type TotalsRow } from './aggregate-repo.js';

/** Four bounded full-table reads; cost is independent of feature/group count. */
export function createUsageSummaryRepo(
  db: Pick<DatabaseSync, 'prepare'>,
  config: Pick<AggregationConfig, 'rollupKinds'>,
): UsageSummaryReader {
  const kinds = config.rollupKinds;
  const kindsPlaceholders = kinds.map(() => '?').join(', ');
  const featuresStmt = db.prepare(
    'SELECT id, parent_feature_id AS parentFeatureId, parent_group_id AS parentGroupId FROM features',
  );
  const groupsStmt = db.prepare(
    'SELECT id, feature_id AS featureId, parent_group_id AS parentGroupId FROM feature_groups',
  );
  const sessionsStmt = db.prepare(
    'SELECT id, feature_id AS featureId, group_id AS groupId FROM sessions WHERE feature_id IS NOT NULL',
  );
  const usageStmt = db.prepare(
    `SELECT feature_id AS featureId, session_id AS sessionId, ${TOTALS_COLUMNS} FROM (
       SELECT feature_id, session_id, input_tokens, output_tokens, reasoning_output_tokens,
              cost, credits, nano_aiu, usd_estimate
         FROM usage_events WHERE feature_id IS NOT NULL AND kind IN (${kindsPlaceholders})
       UNION ALL
       SELECT feature_id, session_id, COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), 0,
              CASE WHEN credits IS NULL THEN NULL ELSE 0 END, credits, nano_aiu, NULL
         FROM meta_usage_records WHERE feature_id IS NOT NULL
       UNION ALL
       SELECT feature_id, session_id, input_tokens, output_tokens, reasoning_output_tokens,
              cost, credits, nano_aiu, usd_estimate
         FROM retained_usage
     ) GROUP BY feature_id, session_id`,
  );
  return {
    features: () => featuresStmt.all() as unknown as UsageSummaryFeatureRow[],
    groups: () => groupsStmt.all() as unknown as UsageSummaryGroupRow[],
    sessions: () => sessionsStmt.all() as unknown as UsageSummarySessionRow[],
    usage: () =>
      (usageStmt.all(...kinds) as unknown as (TotalsRow & { featureId: string; sessionId: string })[]).map(
        (row) => ({ sessionId: row.sessionId, featureId: row.featureId, ...toTotals(row) }) as UsageSummaryUsageRow,
      ),
  };
}
