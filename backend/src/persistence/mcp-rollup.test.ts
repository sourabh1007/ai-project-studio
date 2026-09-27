import { describe, expect, it } from 'vitest';
import { aggregationDefaults } from '../aggregation/config.js';
import { ideUsageDefaults } from '../ide-usage/config.js';
import type { McpObservedCall, McpServerUsageRecord } from '../mcp-usage/mcp-usage-contract.js';
import { createAggregateRepo } from './aggregate-repo.js';
import { createDatabase } from './db/connection.js';
import { createMcpUsageRepo } from './mcp-usage-repo.js';
import { toMcpBreakdown } from './mcp-rollup.js';
import { createUsageRollupRepo } from './usage-rollup-repo.js';

function seed() {
  const db = createDatabase({ databasePath: ':memory:' });
  const repo = createMcpUsageRepo(db);
  const observed = (overrides: Partial<McpObservedCall> = {}) => repo.recordObserved({
    featureId: 'f1', sessionId: 's1', provider: 'copilot', server: 'github',
    callId: 'call-1', origin: 'configured', scope: 'feature',
    recordedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  });
  const proxy = (overrides: Partial<McpServerUsageRecord> = {}) => repo.record({
    featureId: 'f1', sessionId: 's1', provider: 'copilot', server: 'github',
    calls: 1, inputBytes: 10, outputBytes: 20, durationMs: 30,
    recordedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  });
  const aggregate = createAggregateRepo(db, aggregationDefaults);
  const rollup = createUsageRollupRepo(db, ideUsageDefaults);
  return { db, observed, proxy, aggregate, rollup };
}

const unavailable = {
  inputTokens: null, outputTokens: null, nanoAiu: null, credits: null,
  attribution: 'unavailable',
};

describe.each(['aggregate', 'rollup'] as const)('%s MCP rollups', (reader) => {
  function setup() {
    const data = seed();
    const read = (featureId = 'f1') => reader === 'aggregate'
      ? data.aggregate.byMcpServer(featureId)
      : data.rollup.featureMcpServers(featureId);
    return { ...data, read };
  }

  it('keeps identical server names under distinct providers and exposes unavailable billing', () => {
    const { db, observed, proxy, read } = setup();
    proxy();
    observed({ provider: 'agency', origin: 'built-in' });
    observed({ provider: 'agency', origin: 'built-in' });
    expect(read()).toEqual([
      { provider: 'agency', server: 'github', origin: 'built-in', calls: 1,
        inputBytes: 0, outputBytes: 0, durationMs: 0, ...unavailable },
      { provider: 'copilot', server: 'github', origin: 'configured', calls: 1,
        inputBytes: 10, outputBytes: 20, durationMs: 30, ...unavailable },
    ]);
    expect(read('missing')).toEqual([]);
    db.close();
  });

  it('takes the max per session, not across all sessions, and never estimates transport I/O', () => {
    const { db, observed, proxy, read } = setup();
    proxy({ calls: 2 });
    proxy({ calls: 3 });
    observed();
    observed({ callId: 'call-2' });
    proxy({ sessionId: 's2', calls: 1 });
    for (let i = 0; i < 4; i++) observed({ sessionId: 's2', callId: `call-${i}` });
    observed({ featureId: 'f2', sessionId: 's3' });
    // max(5, 2) + max(1, 4), not max(6, 6).
    expect(read()).toEqual([{
      provider: 'copilot', server: 'github', origin: 'configured', calls: 9,
      inputBytes: 30, outputBytes: 60, durationMs: 90, ...unavailable,
    }]);
    expect(read('f2')[0].calls).toBe(1);
    db.close();
  });

  it('marks origin unknown for explicit unknowns and conflicting sources or sessions', () => {
    const { db, observed, proxy, read } = setup();
    proxy();
    observed({ origin: 'built-in' });
    observed({ server: 'mixed', origin: 'built-in', callId: 'm1' });
    observed({ server: 'mixed', origin: 'configured', sessionId: 's2', callId: 'm2' });
    observed({ server: 'unknown', origin: 'unknown', callId: 'u1' });
    expect(read().map(({ server, origin }) => ({ server, origin }))).toEqual([
      { server: 'github', origin: 'unknown' },
      { server: 'mixed', origin: 'unknown' },
      { server: 'unknown', origin: 'unknown' },
    ]);
    db.close();
  });

  it('keeps unattributed proxy calls separate from observed session identities', () => {
    const { db, observed, proxy, read } = setup();
    proxy({ sessionId: null, calls: 2 });
    observed();
    expect(read()[0].calls).toBe(3);
    db.close();
  });
});

describe('MCP rollup scopes', () => {
  it('uses explicit internal scope for warm calls even without session or usage rows', () => {
    const { db, observed, rollup } = seed();
    observed({ sessionId: 'provider-warm-session', scope: 'internal', origin: 'built-in' });
    observed({ sessionId: 'feature-session', server: 'filesystem', origin: 'configured' });
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([]);
    expect(rollup.workspaceMcpServers()).toEqual([{
      provider: 'copilot', server: 'filesystem', origin: 'configured', calls: 1,
      inputBytes: 0, outputBytes: 0, durationMs: 0, ...unavailable,
    }]);
    expect(rollup.ideMcpServers()).toEqual([{
      provider: 'copilot', server: 'github', origin: 'built-in', calls: 1,
      inputBytes: 0, outputBytes: 0, durationMs: 0, ...unavailable,
    }]);
    expect(rollup.featureMcpServers('f1')).toHaveLength(2);
    db.close();
  });

  it('keeps feature keys separate before combining workspace totals', () => {
    const { db, observed, proxy, rollup } = seed();
    proxy({ calls: 3 });
    observed({ featureId: 'f2' });
    expect(rollup.workspaceMcpServers()[0].calls).toBe(4);
    db.close();
  });

  it('normalizes bigint database values without inventing token or credit values', () => {
    expect(toMcpBreakdown({
      provider: 'copilot', server: 'github', origin: 'unknown',
      calls: 1n, inputBytes: 2n, outputBytes: 3n, durationMs: 4n,
    })).toEqual({
      provider: 'copilot', server: 'github', origin: 'unknown',
      calls: 1, inputBytes: 2, outputBytes: 3, durationMs: 4, ...unavailable,
    });
  });
});
