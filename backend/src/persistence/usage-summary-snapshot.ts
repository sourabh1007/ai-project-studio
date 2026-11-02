import type { DatabaseSync } from 'node:sqlite';
import { createUsageSummaryService } from '../usage-summary/usage-summary-service.js';
import type { UsageSummary } from '../usage-summary/usage-summary-contract.js';
import { createUsageSummaryRepo } from './usage-summary-repo.js';

/** Builds the summary inside one read transaction so the four statements see a single snapshot. */
export function readUsageSummarySnapshot(
  db: Pick<DatabaseSync, 'prepare' | 'exec'>,
  rollupKinds: readonly string[],
): UsageSummary {
  const reader = createUsageSummaryRepo(db, { rollupKinds } as never);
  db.exec('BEGIN');
  try {
    return createUsageSummaryService({ reader }).summary();
  } finally {
    db.exec('COMMIT');
  }
}
