import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../persistence/db/connection.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createRecordingMetaRunner } from '../meta/recording-meta-runner.js';
import { createMetaOperationOwnership } from '../meta/meta-operation-ownership.js';
import { createAcpMetaRunner } from '../meta/acp/acp-meta-runner.js';
import { MetaSessionPool, type PooledClient } from '../meta/acp/acp-pool.js';
import type { AcpTurnRequest, AcpTurnResult } from '../meta/acp/acp-client.js';
import { metaPoolsStatus } from '../meta/pooled-meta-runner.js';
import { createClock } from '../kernel/clock.js';
import { activeSessionsDefaults } from './config.js';
import { createMetaDebugTracker, observeMetaOperations, observeMetaRunner } from './meta-debug-tracker.js';
import { createActiveSessionsService } from './active-sessions-service.js';

describe('real recording / warm pool / debugger integration with a fake provider', () => {
  it('inspects a live partial response and completed turn without dispatching any additional work', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    let request!: AcpTurnRequest;
    let finish!: (result: AcpTurnResult) => void;
    let exited!: () => void;
    const runTurn = vi.fn((next: AcpTurnRequest) => {
      request = next;
      next.onSession?.('provider-session');
      return new Promise<AcpTurnResult>((resolve) => { finish = resolve; });
    });
    const client: PooledClient = {
      alive: true, reusable: true, initialize: async () => {}, runTurn,
      onExit: (handler) => { exited = handler; }, dispose: () => exited(),
    };
    const pool = new MetaSessionPool({ size: 1, createClient: () => client });
    const tracker = createMetaDebugTracker(activeSessionsDefaults);
    const operations = observeMetaOperations(createMetaOperationRepo(db), tracker);
    const warm = createAcpMetaRunner({ pool, newSessionId: () => 'app-session', providerId: 'copilot', defaultModel: () => 'auto' });
    const base = { ...warm, run: async () => '' };
    const runner = createRecordingMetaRunner({
      base: observeMetaRunner(base, tracker), operations, ownership: createMetaOperationOwnership(), clock: createClock(),
      newOperationId: () => 'operation', resolveIdentity: () => ({ providerId: 'copilot', requestedModel: 'auto' }),
    });
    const monitor = createActiveSessionsService({
      config: activeSessionsDefaults, tracker, now: () => 10, sessions: () => [],
      pools: () => metaPoolsStatus(true, { stats: () => pool.stats() }),
      context: () => ({ featureName: 'Feature', projectName: 'Project' }),
    });
    try {
      await pool.start();
      expect(monitor.snapshot().entries[0].state).toBe('idle');
      const running = runner.runDetailed({ featureId: 'f', purpose: 'review', label: 'Review PR', prompt: 'DO NOT EXPOSE PROMPT' });
      await new Promise((resolve) => setImmediate(resolve));
      request.onActivity?.('Partial assistant response');
      request.onNotice?.('🔧 running read · private tool arguments');
      expect(monitor.snapshot().entries).toHaveLength(1);
      expect(monitor.snapshot().entries[0]).toMatchObject({ operationId: 'operation', state: 'busy', projectName: 'Project' });
      const live = monitor.debug('warm:s1');
      expect(live.output).toBe('Partial assistant response');
      expect(live.activity).toEqual(['🔧 running read']);
      expect(JSON.stringify(live)).not.toContain('DO NOT EXPOSE PROMPT');
      expect(JSON.stringify(live)).not.toContain('private tool arguments');
      expect(runTurn).toHaveBeenCalledTimes(1);
      finish({ sessionId: 'provider-session', text: 'Final response', stopReason: 'end_turn', usage: null });
      await running;
      expect(monitor.snapshot().entries[0].state).toBe('idle');
      expect(monitor.debug('warm:s1')).toMatchObject({ state: 'completed', output: 'Final response' });
      expect(runTurn).toHaveBeenCalledTimes(1);
    } finally { pool.close(); db.close(); }
  });
});
