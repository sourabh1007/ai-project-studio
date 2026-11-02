import { describe, expect, it } from 'vitest';
import { createDatabase } from '../persistence/db/connection.js';
import { createUsageRepo } from '../persistence/usage-repo.js';
import { createUsageCaptureRepo } from '../persistence/usage-capture-repo.js';
import { createMetaUsageRepo } from '../persistence/meta-usage-repo.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createMcpUsageRepo } from '../persistence/mcp-usage-repo.js';
import { createSessionFilesRepo } from '../persistence/session-files-repo.js';
import { createRetainedUsageRepo } from '../persistence/retained-usage-repo.js';
import { createSessionRepo } from '../persistence/session-repo.js';
import { createAggregateRepo } from '../persistence/aggregate-repo.js';
import { createSqliteUnitOfWork } from '../persistence/sqlite-unit-of-work.js';
import { createWorkspaceAdmin } from './workspace-admin-service.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';

function usage(o: Partial<StoredUsage> = {}): StoredUsage {
  return {
    sessionId: 's1', featureId: 'f1', turnIndex: 0, kind: 'dev', provider: 'github', requestedModel: 'auto',
    resolvedModel: 'gpt-5.4', operation: 'chat', inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 0,
    cost: 0.3, credits: 0.3, nanoAiu: 1000, serviceRequestId: 'r',
    startedAt: '2026-01-01T00:00:02.000Z', endedAt: '2026-01-01T00:00:03.000Z', ...o,
  };
}

function setup(options: { failOnce?: boolean; credits?: number | null } = {}) {
  const db = createDatabase({ databasePath: ':memory:' });
  const usageRepo = createUsageRepo(db);
  const sessions = createSessionRepo(db);
  sessions.save({
    id: 's1', featureId: 'f1', name: null, provider: 'github', requestedModel: 'auto', resolvedModel: null,
    status: 'completed', kind: 'dev', scope: 'feature', prompt: '', usageFilePath: 'x',
    createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, endedAt: null, exitCode: null,
  });
  usageRepo.saveAll([usage({ credits: options.credits === undefined ? 0.3 : options.credits })]);
  let fail = options.failOnce === true;
  const admin = createWorkspaceAdmin({
    features: { get: () => ({ name: 'F' }) as never, list: () => [], rename: () => ({}) as never, remove: () => {} },
    sessions,
    quiescence: { feature: async () => {}, session: async () => {} },
    usage: usageRepo,
    retainedUsage: createRetainedUsageRepo(db),
    clock: { isoNow: () => '2026-01-05T00:00:00.000Z' },
    unitOfWork: createSqliteUnitOfWork(db),
    usageCaptures: createUsageCaptureRepo(db),
    metaUsage: createMetaUsageRepo(db),
    metaOperations: createMetaOperationRepo(db),
    mcpUsage: {
      ...createMcpUsageRepo(db),
      deleteBySession: (id: string) => {
        if (fail) { fail = false; throw new Error('SQLITE_BUSY'); }
        createMcpUsageRepo(db).deleteBySession(id);
      },
    },
    transcripts: { delete: async () => {} },
    summaries: { delete: () => {} },
    sessionFiles: createSessionFilesRepo(db),
    terminals: { close: () => {} },
  } as never);
  const agg = createAggregateRepo(db, { rollupKinds: ['dev', 'meta'] });
  return { db, admin, agg, usageRepo };
}

describe('session purge atomicity', () => {
  it('an interrupted purge leaves neither a retained copy nor a double count', async () => {
    const { admin, agg, db } = setup({ failOnce: true });
    await expect(admin.deleteSession('s1')).rejects.toThrow('SQLITE_BUSY');
    expect(agg.featureTotals('f1').credits).toBeCloseTo(0.3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM retained_usage').get()).toEqual({ n: 0 });
    expect(db.isTransaction).toBe(false);
  });

  it('a retry after the interruption converges to the retained total exactly once', async () => {
    const { admin, agg, db } = setup({ failOnce: true });
    await expect(admin.deleteSession('s1')).rejects.toThrow('SQLITE_BUSY');
    await admin.deleteSession('s1');
    expect(agg.featureTotals('f1').credits).toBeCloseTo(0.3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 0 });
  });

  it('keeps unknown billing unknown through a purge', async () => {
    const { admin, agg } = setup({ credits: null });
    await admin.deleteSession('s1');
    expect(agg.featureTotals('f1').credits).toBeNull();
  });
});
