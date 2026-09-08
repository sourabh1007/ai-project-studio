import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createClock } from '../kernel/clock.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createMetaUsageRepo } from '../persistence/meta-usage-repo.js';
import { createRecordingMetaRunner, MetaOperationPersistenceError, MetaOperationRemovedError } from './recording-meta-runner.js';
import { createMetaOperationOwnership } from './meta-operation-ownership.js';
import { createMetaOperationRecovery } from './meta-operation-recovery.js';
import { createMetaRunner, MetaAbortError, type MetaRunResult, type MetaRunner } from './meta-runner.js';
import type { MetaOperationRequest, MetaOperationRepo } from './meta-operation-contract.js';
import { createAcpMetaRunner } from './acp/acp-meta-runner.js';
import { createPooledMetaRunner } from './pooled-meta-runner.js';
import { createMetaOperationsRoutes } from '../api/meta-operations-controller.js';
import { metaOperationsDefaults } from './meta-operations-config.js';
import { metaDefaults } from './config.js';
import { createMetaOperationPhysicalOwnership } from './meta-operation-physical-ownership.js';
import { AcpRequestError } from './acp/acp-client.js';

const result = (overrides: Partial<MetaRunResult> = {}): MetaRunResult => ({
  text: 'x'.repeat(1200), sessionId: 'app-session', providerId: 'copilot', requestedModel: 'auto',
  transport: 'warm-acp', providerSessionId: 'provider-session', resolvedModel: 'actual-model',
  usage: { inputTokens: 10, outputTokens: 4, nanoAiu: null, credits: null }, ...overrides,
});
const clock = createClock(() => Date.parse('2026-01-01T00:00:00Z'));

describe('durable recording meta runner with production SQLite', () => {
  let db: DatabaseSync;
  let repo: MetaOperationRepo;
  let directories: string[];
  beforeEach(() => { db = createDatabase({ databasePath: ':memory:' }); repo = createMetaOperationRepo(db); directories = []; });
  afterEach(() => { db.close(); for (const directory of directories) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
  const setup = (run: (request: MetaOperationRequest) => Promise<MetaRunResult> = async (request) => {
    request.onStart?.('app-session');
    return result();
  }) => {
    let id = 0;
    const base = { run: vi.fn(async () => 'unused'), runDetailed: vi.fn(run) } satisfies MetaRunner;
    const ownership = createMetaOperationOwnership();
    const identity = vi.fn((request: MetaOperationRequest) => ({
      providerId: request.providerId ?? 'copilot', requestedModel: request.model ?? 'auto',
    }));
    const runner = createRecordingMetaRunner({ base, operations: repo, ownership, clock,
      newOperationId: () => `op-${++id}`, resolveIdentity: identity });
    return { runner, base, ownership, identity };
  };

  const preflightSetup = () => {
    let attemptId = 0;
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => `attempt-${++attemptId}` });
    const ownership = createMetaOperationOwnership({ physical });
    const start = vi.fn(async () => { throw new Error('Preflight must not launch'); });
    const cold = createMetaRunner({
      physicalOwnership: physical,
      launcher: { start },
      transcripts: { load: async () => null, save: async () => {}, delete: async () => {} },
      config: metaDefaults,
    });
    const record = (base: MetaRunner) => createRecordingMetaRunner({
      base, ownership, operations: repo, clock,
      newOperationId: () => 'preflight',
      resolveIdentity: () => ({ providerId: 'copilot', requestedModel: 'auto' }),
    });
    return { physical, ownership, start, cold, record };
  };

  it.each(['cold', 'pooled', 'bypass'] as const)(
    'does not retain phantom physical work after an expired %s preflight',
    async (path) => {
      const h = preflightSetup();
      const routed = path === 'cold' ? h.cold : createPooledMetaRunner({
        physicalOwnership: h.physical, pools: [], fallback: h.cold,
        defaultTimeoutMs: 1000, bypass: () => path === 'bypass',
      });
      await expect(h.record(routed).runDetailed({
        featureId: 'f', originSessionId: 'origin', prompt: 'go', deadlineAt: Date.now() - 1,
      })).rejects.toMatchObject({ kind: 'timed_out', termination: 'not-started' });
      expect(h.start).not.toHaveBeenCalled();
      expect(repo.get('preflight')).toMatchObject({
        state: 'interrupted', outcome: 'not-dispatched', sessionId: null,
      });
      expect(await h.ownership.quiesceFeature('f', 100)).toBe(true);
      expect(h.ownership.unconfirmed()).toEqual([]);
    },
  );

  it.each(['cold', 'pooled'] as const)(
    'certifies %s cancellation after recording but before dispatch',
    async (path) => {
      const h = preflightSetup();
      const controller = new AbortController();
      const update = repo.update;
      vi.spyOn(repo, 'update').mockImplementation((operation) => {
        const saved = update(operation);
        if (operation.state === 'running') controller.abort();
        return saved;
      });
      const routed = path === 'cold' ? h.cold : createPooledMetaRunner({
        physicalOwnership: h.physical, pools: [], fallback: h.cold, defaultTimeoutMs: 1000,
      });
      await expect(h.record(routed).runDetailed({
        featureId: 'f', prompt: 'go', signal: controller.signal,
      })).rejects.toMatchObject({ kind: 'aborted', termination: 'not-started' });
      expect(h.start).not.toHaveBeenCalled();
      expect(await h.ownership.quiesceFeature('f', 100)).toBe(true);
      expect(h.ownership.unconfirmed()).toEqual([]);
    },
  );

  it('retains an earlier unconfirmed warm attempt when cold fallback expires before dispatch', async () => {
    const h = preflightSetup();
    let nativeExit!: () => void;
    const settled = new Promise<'exited'>((resolve) => { nativeExit = () => resolve('exited'); });
    const stop = vi.fn(async () => 'unconfirmed' as const);
    const routed = createPooledMetaRunner({
      physicalOwnership: h.physical, fallback: h.cold, defaultTimeoutMs: 1000,
      pools: [{
        purpose: 'general', ready: () => true, stats: () => { throw new Error('unused'); },
        runDetailed: async (request) => {
          h.physical.register(request.operationId!, { ownerId: 'warm', settled, quiesce: stop });
          throw new AcpRequestError('Pre-dispatch handshake failed', {
            method: 'session/new', allowFallbackToCold: true,
          });
        },
      }],
    });
    await expect(h.record(routed).runDetailed({
      featureId: 'f', prompt: 'go', deadlineAt: Date.now() - 1,
    })).rejects.toMatchObject({ kind: 'timed_out', termination: 'not-started' });
    expect(h.start).not.toHaveBeenCalled();
    expect(await h.ownership.quiesceFeature('f', 0)).toBe(false);
    expect(stop).toHaveBeenCalled();
    expect(h.ownership.unconfirmed()).toHaveLength(1);
    nativeExit();
    expect(await h.ownership.quiesceFeature('f', 100)).toBe(true);
    expect(h.ownership.unconfirmed()).toEqual([]);
  });

  it('persists pending before dispatch, in-flight attribution before publication, and full result plus usage before success', async () => {
    const h = setup(async (request) => {
      expect(request.operationId).toBe('op-1');
      expect(repo.get('op-1')).toMatchObject({ state: 'running', providerId: 'copilot', requestedModel: 'auto', automationId: 'a', originSessionId: 'origin' });
      request.onStart?.('app-session', { providerSessionId: 'known-provider', transport: 'warm-acp' });
      return result();
    });
    const started = vi.fn(() => expect(repo.get('op-1')).toMatchObject({ sessionId: 'app-session', providerSessionId: 'known-provider' }));
    const request: MetaOperationRequest = { operationId: 'caller-cannot-choose', featureId: 'f', automationId: 'a', originSessionId: 'origin',
      prompt: 'go', purpose: 'review', label: 'Review', onStart: started };
    const out = await h.runner.runDetailed(request);
    expect(out.operationId).toBe('op-1');
    expect(started).toHaveBeenCalledTimes(1);
    expect(repo.get('op-1')).toMatchObject({ state: 'completed', outcome: 'returned', resultText: 'x'.repeat(1200), usageState: 'partial', sessionIds: ['app-session'] });
    expect(createMetaUsageRepo(db).get('app-session')).toMatchObject({ inputTokens: 10, credits: null });
  });

  it('freezes defaults into the actual request and preserves attachments/tools/deadline constraints on cold results', async () => {
    const h = setup(async (request) => {
      expect(request).toMatchObject({ providerId: 'chosen', model: 'frozen', attachments: ['owned-fixture'], noTools: true, deadlineAt: 42, timeoutMs: 20 });
      return result({ transport: 'session', providerId: undefined, requestedModel: undefined, providerSessionId: undefined, usage: undefined });
    });
    h.identity.mockReturnValue({ providerId: 'chosen', requestedModel: 'frozen' });
    await expect(h.runner.run({ featureId: 'f', prompt: 'go', attachments: ['owned-fixture'], noTools: true, deadlineAt: 42, timeoutMs: 20 })).resolves.toHaveLength(1200);
    expect(repo.get('op-1')).toMatchObject({ providerId: 'chosen', requestedModel: 'frozen', state: 'completed', usageState: 'unknown' });
    expect(createMetaUsageRepo(db).get('app-session')).toBeNull();
  });

  it('distinguishes concurrent operations sharing one provider session and retains every output across reopening', async () => {
    const dir = join(process.cwd(), `.meta-operation-fixture-${randomUUID()}`);
    mkdirSync(dir); directories.push(dir);
    const path = join(dir, 'app.db');
    db.close(); db = createDatabase({ databasePath: path }); repo = createMetaOperationRepo(db);
    let appId = 0;
    const adapter = createAcpMetaRunner({
      pool: { run: async (request) => {
        request.onStart?.();
        return { text: request.prompt.repeat(1200), sessionId: 'reused-provider-session', stopReason: 'end_turn', usage: null };
      } },
      newSessionId: () => `app-${++appId}`, providerId: 'copilot', defaultModel: () => 'auto',
    });
    const h = setup((request) => adapter.runDetailed(request));
    await Promise.all([h.runner.runDetailed({ featureId: 'f', prompt: 'A' }), h.runner.runDetailed({ featureId: 'f', prompt: 'B' })]);
    db.close(); db = createDatabase({ databasePath: path }); repo = createMetaOperationRepo(db);
    expect(repo.get('op-1')).toMatchObject({ resultText: 'A'.repeat(1200), providerSessionId: 'reused-provider-session', sessionId: 'app-1' });
    expect(repo.get('op-2')).toMatchObject({ resultText: 'B'.repeat(1200), providerSessionId: 'reused-provider-session', sessionId: 'app-2' });
    const routes = createMetaOperationsRoutes({ operations: repo, config: metaOperationsDefaults });
    expect(await routes[1].handler({ params: { operationId: 'op-1' }, query: {}, body: null }))
      .toMatchObject({ status: 200, body: { resultText: 'A'.repeat(1200), sessionId: 'app-1' } });
    expect(await routes[1].handler({ params: { operationId: 'op-2' }, query: {}, body: null }))
      .toMatchObject({ status: 200, body: { resultText: 'B'.repeat(1200), sessionId: 'app-2' } });
  });

  it('records pre-start cancellation without dispatching and retains explicit unknown outcomes after interruption', async () => {
    const controller = new AbortController(); controller.abort();
    const h = setup();
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go', signal: controller.signal })).rejects.toBeInstanceOf(MetaAbortError);
    expect(h.base.runDetailed).not.toHaveBeenCalled();
    expect(repo.get('op-1')).toMatchObject({ state: 'interrupted', outcome: 'not-dispatched', sessionId: null });
    const started = setup(async (request) => {
      request.onStart?.('running-session');
      throw new MetaAbortError({ kind: 'aborted', termination: 'confirmed' });
    });
    repo.deleteByFeature('f');
    await expect(started.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toThrow();
    expect(repo.get('op-1')).toMatchObject({ state: 'interrupted', outcome: 'unknown', sessionId: 'running-session' });
  });

  it('holds unconfirmed warm physical ownership after its durable interrupted row is saved', async () => {
    vi.useFakeTimers();
    const h = setup(async (request) => {
      request.onStart?.('running-session');
      throw new MetaAbortError({ kind: 'aborted', termination: 'unconfirmed' });
    });
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toThrow();
    expect(repo.get('op-1')).toMatchObject({ state: 'interrupted', outcome: 'unknown' });
    const quiet = h.ownership.quiesceFeature('f', 5);
    await vi.advanceTimersByTimeAsync(5);
    await expect(quiet).resolves.toBe(false);
    h.ownership.confirmTermination('op-1');
    await expect(h.ownership.quiesceFeature('f', 100)).resolves.toBe(true);
  });

  it('never dispatches after pending or running persistence fails', async () => {
    const h = setup();
    db.exec(`CREATE TRIGGER usage.reject_operation BEFORE INSERT ON meta_operations BEGIN SELECT RAISE(FAIL,'write failed'); END`);
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toBeInstanceOf(MetaOperationPersistenceError);
    expect(h.base.runDetailed).not.toHaveBeenCalled();
    db.exec(`DROP TRIGGER usage.reject_operation;
      CREATE TRIGGER usage.reject_operation BEFORE UPDATE ON meta_operations BEGIN SELECT RAISE(FAIL,'write failed'); END`);
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toBeInstanceOf(MetaOperationPersistenceError);
    expect(h.base.runDetailed).not.toHaveBeenCalled();
    expect(repo.get('op-2')).toMatchObject({ state: 'pending', resultText: null });
  });

  it('does not re-enter warm/cold routing after atomic completion fails and retains the full failed result', async () => {
    const cold = { run: vi.fn(async () => 'cold'), runDetailed: vi.fn(async () => result({ transport: 'session' })) };
    const warm = vi.fn(async () => result());
    const pooled = createPooledMetaRunner({
      pools: [{ purpose: 'general', ready: () => true, stats: () => { throw new Error('unused'); }, runDetailed: warm }],
      fallback: cold, defaultTimeoutMs: 1000,
    });
    const h = setup((request) => pooled.runDetailed(request));
    db.exec(`CREATE TRIGGER usage.reject_usage BEFORE INSERT ON meta_usage_records BEGIN SELECT RAISE(FAIL,'usage write failed'); END`);
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toBeInstanceOf(MetaOperationPersistenceError);
    expect(warm).toHaveBeenCalledTimes(1); expect(cold.runDetailed).not.toHaveBeenCalled();
    expect(repo.get('op-1')).toMatchObject({ state: 'failed', outcome: 'returned', resultText: 'x'.repeat(1200) });
    expect(createMetaUsageRepo(db).get('app-session')).toBeNull();
  });

  it('closes admission before feature purge and ignores late start callbacks after a removed operation', async () => {
    let lateStart: MetaOperationRequest['onStart'];
    const h = setup(async (request) => {
      lateStart = request.onStart;
      repo.deleteByFeature('f');
      return result();
    });
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toBeInstanceOf(MetaOperationRemovedError);
    lateStart?.('late');
    expect(repo.get('op-1')).toBeNull();
    expect(createMetaUsageRepo(db).get('app-session')).toBeNull();
    await h.ownership.quiesceFeature('f', 0);
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'again' })).rejects.toThrow('scope is closed');
    expect(h.base.runDetailed).toHaveBeenCalledTimes(1);
  });

  it('aborts rather than throwing through routing when start persistence/callback publication fails', async () => {
    const h = setup(async (request) => {
      request.onStart?.('app-session');
      expect(request.signal?.aborted).toBe(true);
      request.onStart?.('ignored-second');
      return result({ providerSessionId: undefined });
    });
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go', onStart: () => { throw new Error('consumer failed'); } })).rejects.toBeInstanceOf(MetaOperationPersistenceError);
    expect(repo.get('op-1')).toMatchObject({ state: 'interrupted', resultText: 'x'.repeat(1200), sessionIds: ['app-session'] });
  });

  it('preserves all observed start IDs without carrying provider-session attribution across fallback attempts', async () => {
    const h = setup(async (request) => {
      request.onStart?.('warm-attempt', { providerId: 'actual-provider', providerSessionId: 'known-provider' });
      request.onStart?.('app-session');
      expect(repo.get('op-1')).toMatchObject({ providerSessionId: null, providerId: 'copilot', transport: 'unknown' });
      request.onStart?.('app-session', { providerId: 'actual-provider', providerSessionId: 'known-provider', transport: 'warm-acp' });
      request.onStart?.('app-session');
      return result({ providerId: undefined, providerSessionId: undefined, resolvedModel: undefined,
        usage: { inputTokens: 0, outputTokens: 0, nanoAiu: 0, credits: 0 } });
    });
    await h.runner.runDetailed({ featureId: 'f', prompt: 'go' });
    expect(repo.get('op-1')).toMatchObject({
      providerId: 'actual-provider', providerSessionId: 'known-provider', resolvedModel: null,
      usageState: 'recorded', sessionIds: ['warm-attempt', 'app-session'],
    });
    const unknown = setup(async () => result({ transport: undefined, usage: { inputTokens: NaN, outputTokens: -1, nanoAiu: null, credits: null } }));
    repo.deleteByFeature('f');
    await unknown.runner.runDetailed({ featureId: 'f', prompt: 'go' });
    expect(repo.get('op-1')).toMatchObject({ transport: 'unknown', usageState: 'unknown', usage: { inputTokens: null, outputTokens: null, nanoAiu: null, credits: null } });
  });

  it('records safe failures for missing defaults, invalid output, and non-Error provider failures', async () => {
    const h = setup();
    h.identity.mockReturnValue({ providerId: '', requestedModel: 'auto' });
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toThrow('identity is unavailable');
    expect(h.base.runDetailed).not.toHaveBeenCalled();
    const invalid = setup(async () => result({ text: undefined as unknown as string }));
    repo.deleteByFeature('f');
    await expect(invalid.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toThrow('text is unavailable');
    const failure = setup(async () => { throw 'not-an-error'; });
    repo.deleteByFeature('f');
    await expect(failure.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toBe('not-an-error');
    expect(repo.get('op-1')).toMatchObject({ state: 'failed', errorMessage: 'Meta operation failed' });
  });

  it('does not publish success if cancellation arrives after the provider returns', async () => {
    const controller = new AbortController();
    const h = setup(async () => { controller.abort(); return result(); });
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go', signal: controller.signal })).rejects.toThrow('cancelled after provider returned');
    expect(repo.get('op-1')).toMatchObject({ state: 'interrupted', outcome: 'returned', resultText: 'x'.repeat(1200) });
  });

  it('retains late session attribution without publishing after origin-session deletion closes admission', async () => {
    let release!: () => void;
    const h = setup(async (request) => {
      await new Promise<void>((resolve) => { release = resolve; });
      request.onStart?.('late-observed');
      expect(repo.get('op-1')).toMatchObject({ sessionIds: ['late-observed'] });
      throw new MetaAbortError({ kind: 'aborted', termination: 'confirmed' });
    });
    const onStart = vi.fn();
    const running = h.runner.runDetailed({ featureId: 'f', originSessionId: 'origin', prompt: 'go', onStart });
    await vi.waitFor(() => expect(h.base.runDetailed).toHaveBeenCalledTimes(1));
    const quiet = h.ownership.quiesceSession('origin', 1000);
    const failed = expect(running).rejects.toBeInstanceOf(MetaAbortError);
    release();
    await failed;
    await expect(quiet).resolves.toBe(true);
    expect(onStart).not.toHaveBeenCalled();
    expect(repo.get('op-1')).toMatchObject({ state: 'interrupted', outcome: 'unknown', sessionIds: ['late-observed'] });
    repo.deleteBySession('origin');
    expect(repo.get('op-1')).toBeNull();
  });

  it('ignores late start publication even if failure-state timestamp generation fails', async () => {
    let lateStart: MetaOperationRequest['onStart'];
    const timestamp = vi.spyOn(clock, 'isoNow');
    const h = setup(async (request) => {
      lateStart = request.onStart;
      timestamp.mockImplementation(() => { throw new Error('clock failed'); });
      throw new Error('provider failed');
    });
    try {
      await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toThrow('clock failed');
    } finally { timestamp.mockRestore(); }
    lateStart?.('late');
    expect(repo.get('op-1')).toMatchObject({ state: 'running', sessionId: null });
    await expect(h.ownership.quiesceAll(0)).resolves.toBe(true);
  });

  it('reconciles orphaned inflight operations in bounded startup pages without invoking the provider', async () => {
    const h = setup(async () => { throw new Error('provider'); });
    await expect(h.runner.runDetailed({ featureId: 'f', prompt: 'go' })).rejects.toThrow();
    const stored = repo.get('op-1')!;
    repo.create({ ...stored, operationId: 'orphan-1', state: 'pending', resultText: null });
    repo.create({ ...stored, operationId: 'orphan-2', state: 'running', resultText: null });
    const recovery = createMetaOperationRecovery({ operations: repo, clock });
    expect(recovery.recoverPage(null, 1)).toEqual({ recovered: 1, nextCursor: 'orphan-1' });
    expect(recovery.recoverPage('orphan-1', 1)).toEqual({ recovered: 1, nextCursor: null });
    expect(repo.get('orphan-2')).toMatchObject({ state: 'interrupted', outcome: 'unknown', resultText: null });
    expect(h.base.runDetailed).toHaveBeenCalledTimes(1);
    expect(createMetaOperationRecovery({ operations: { listUnfinishedPage: () => ({ items: [stored], nextCursor: null }), update: () => false }, clock }).recoverPage(null, 1)).toEqual({ recovered: 0, nextCursor: null });
  });
});
