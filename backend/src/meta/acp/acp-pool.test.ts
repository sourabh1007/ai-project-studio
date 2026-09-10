import { describe, it, expect, vi } from 'vitest';
import { MetaPoolCloseError, MetaSessionPool, type PooledClient } from './acp-pool.js';
import { AcpClient, type AcpProcess, type AcpTurnRequest, type AcpTurnResult } from './acp-client.js';
import { createMetaOperationPhysicalOwnership } from '../meta-operation-physical-ownership.js';
import { createAcpMetaRunner } from './acp-meta-runner.js';
import type { MetaOperationPhysicalOwner } from '../meta-operation-contract.js';
import { createMetaOperationOwnership } from '../meta-operation-ownership.js';
import { createRecordingMetaRunner } from '../recording-meta-runner.js';
import { createDatabase } from '../../persistence/db/connection.js';
import { createMetaOperationRepo } from '../../persistence/meta-operation-repo.js';
import { createClock } from '../../kernel/clock.js';
import { createProcessAdmission } from '../../kernel/process-admission.js';
import { drainMetaPool } from '../pool-drain.js';

interface FakeOptions {
  initFails?: boolean;
  run?: (request: AcpTurnRequest) => Promise<AcpTurnResult>;
  disposeExits?: boolean;
}

class FakeClient implements PooledClient {
  alive = true;
  reusable = true;
  killed = 0;
  readonly turns: AcpTurnRequest[] = [];
  private readonly exitHandlers: (() => void)[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  initialize(): Promise<void> {
    return this.options.initFails
      ? Promise.reject(new Error('boot failed'))
      : Promise.resolve();
  }

  runTurn(request: AcpTurnRequest): Promise<AcpTurnResult> {
    this.turns.push(request);
    if (this.options.run) {
      return this.options.run(request);
    }
    return Promise.resolve({
      text: 'ok',
      sessionId: 's',
      stopReason: 'end_turn',
      usage: null,
    });
  }

  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  dispose(): void {
    this.killed += 1;
    this.reusable = false;
    if (this.options.disposeExits ?? true) {
      this.exit();
    }
  }

  exit(): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    for (const handler of this.exitHandlers) {
      handler();
    }
  }
}

const flush = () => new Promise((r) => setImmediate(r));

describe('fair retryable native pool shutdown', () => {
  it('keeps a removed pool visible and never replenishes while a failed retirement is retried', async () => {
    vi.useFakeTimers();
    const budget = createProcessAdmission({ maxProcesses: 3, maxWarmProcesses: 2, maxQueued: 2 });
    const clients = [new FakeClient({ disposeExits: false }), new FakeClient({ disposeExits: false })];
    const original = clients[1].dispose.bind(clients[1]);
    vi.spyOn(clients[1], 'dispose').mockImplementationOnce(() => {
      original(); throw new Error('Native kill failure');
    });
    let next = 0;
    const createClient = vi.fn(() => clients[next++]);
    const pool = new MetaSessionPool({ size: 2, processAdmission: budget, createClient });
    const onDrained = vi.fn();
    const onError = vi.fn();
    try {
      await pool.start();
      drainMetaPool({ pool, onDrained, onError });
      expect(onError).toHaveBeenCalledOnce();
      expect(pool.stats()).toMatchObject({ size: 0, live: 2, idle: 0 });
      clients[0].exit();
      await vi.advanceTimersByTimeAsync(700);
      expect(clients[1].killed).toBe(2);
      expect(onDrained).not.toHaveBeenCalled();
      expect(createClient).toHaveBeenCalledTimes(2);
      clients[1].exit();
      await vi.advanceTimersByTimeAsync(700);
      expect(onDrained).toHaveBeenCalledOnce();
      expect(budget.stats().processes).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clients.forEach((client) => client.exit());
      pool.close(); budget.close();
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it('continues a failed shrink and retries quarantined native clients on the next resize', async () => {
    const budget = createProcessAdmission({ maxProcesses: 3, maxWarmProcesses: 2, maxQueued: 2 });
    const clients = [new FakeClient({ disposeExits: false }), new FakeClient({ disposeExits: false })];
    let failKill = true;
    const dispose = clients[1].dispose.bind(clients[1]);
    vi.spyOn(clients[1], 'dispose').mockImplementation(() => {
      dispose();
      if (failKill) throw new Error('Transient native kill failure');
    });
    let next = 0;
    const pool = new MetaSessionPool({ size: 2, processAdmission: budget, createClient: () => clients[next++] });
    try {
      await pool.start();
      expect(() => pool.resize(0)).toThrow();
      expect(clients.map((client) => client.killed)).toEqual([1, 1]);
      expect(pool.stats()).toMatchObject({ size: 0, live: 2, idle: 0 });
      expect(budget.stats().processes).toBe(2);
      failKill = false;
      pool.resize(0);
      expect(clients.map((client) => client.killed)).toEqual([2, 2]);
      expect(budget.stats().processes).toBe(2);
      clients[0].exit(); clients[1].exit();
      expect(pool.stats().live).toBe(0);
      expect(budget.stats().processes).toBe(0);
    } finally {
      failKill = false;
      clients.forEach((client) => client.exit());
      pool.close(); budget.close();
    }
  });

  it('sweeps actual clients despite a throwing kill and retains each native permit until confirmed exit', async () => {
    const budget = createProcessAdmission({ maxProcesses: 3, maxWarmProcesses: 2, maxQueued: 2 });
    const processes = Array.from({ length: 2 }, () => {
      const state = { attempts: 0, throwKill: false };
      let line!: (value: string) => void;
      let exit!: (code: number | null) => void;
      const process: AcpProcess = {
        onLine: (handler) => { line = handler; },
        onExit: (handler) => { exit = handler; },
        write: (value) => {
          const request = JSON.parse(value) as { id: number };
          line(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
        },
        kill: () => {
          state.attempts += 1;
          if (state.throwKill) throw new Error('native kill failed');
        },
      };
      return { state, process, exit: () => exit(0) };
    });
    const clients = processes.map(({ process }) => new AcpClient(process, { initializeTimeoutMs: 100, turnTimeoutMs: 100 }));
    let next = 0;
    const pool = new MetaSessionPool({ size: 2, processAdmission: budget, createClient: () => clients[next++] });
    try {
      await pool.start();
      await pool.acquire(); await pool.acquire();
      const queued = pool.acquire();
      const rejected = expect(queued).rejects.toThrow('closed');
      processes[0].state.throwKill = true;
      expect(() => pool.close()).toThrow(MetaPoolCloseError);
      await rejected;
      expect(processes.map(({ state }) => state.attempts)).toEqual([1, 1]);
      expect(clients.map((client) => client.alive)).toEqual([true, true]);
      expect(budget.stats()).toMatchObject({ processes: 2, queued: 0 });
      processes[0].state.throwKill = false;
      pool.close();
      expect(processes.map(({ state }) => state.attempts)).toEqual([2, 2]);
      expect(budget.stats().processes).toBe(2);
      processes[0].state.throwKill = true;
      expect(await pool.closeAndWait(0)).toBe(false);
      expect(processes.map(({ state }) => state.attempts)).toEqual([3, 3]);
      expect(budget.stats().processes).toBe(2);
      processes[0].state.throwKill = false;
      const stopped = pool.closeAndWait(100);
      processes[0].exit();
      expect(budget.stats().processes).toBe(1);
      processes[0].exit();
      expect(budget.stats().processes).toBe(1);
      processes[1].exit();
      expect(await stopped).toBe(true);
      expect(budget.stats().processes).toBe(0);
      pool.close();
      expect(processes.map(({ state }) => state.attempts)).toEqual([4, 4]);
    } finally {
      processes.forEach((entry) => { entry.state.throwKill = false; entry.exit(); });
      pool.close(); budget.close();
    }
  });

  it('does not mask an unrelated close failure as an unconfirmed native exit', () => {
    const pool = new MetaSessionPool({ size: 0, createClient: () => new FakeClient() });
    vi.spyOn(pool, 'close').mockImplementation(() => { throw new Error('unexpected close failure'); });
    expect(() => pool.closeAndWait(0)).toThrow('unexpected close failure');
  });
});

describe('bounded warm native admission', () => {
  it.each([true, false])('honors reconfiguration during native creation without bootstrapping a retired client (exit=%s)', async (disposeExits) => {
    const budget = createProcessAdmission({ maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 1 });
    const client = new FakeClient({ disposeExits });
    const initialize = vi.spyOn(client, 'initialize');
    const pool = new MetaSessionPool({ size: 1, processAdmission: budget, replenishDelayMs: 0, createClient: () => {
      budget.reconfigure({ maxProcesses: 2, maxWarmProcesses: 0, maxQueued: 1 });
      return client;
    } });
    await pool.start();
    expect(initialize).not.toHaveBeenCalled();
    expect(budget.stats().processes).toBe(disposeExits ? 0 : 1);
    pool.close(); client.exit();
    expect(budget.stats().processes).toBe(0);
  });
  it('counts pending boot, resized/retired clients and quarantine until native exit; resumes on capacity changes', async () => {
    const budget = createProcessAdmission({ maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 2 });
    const cold = await budget.acquireCold();
    const clients: FakeClient[] = [];
    let initialized!: () => void;
    const pool = new MetaSessionPool({ size: 10, processAdmission: budget, createClient: () => {
      const client = new FakeClient({ disposeExits: false });
      if (clients.length === 0) client.initialize = () => new Promise<void>((resolve) => { initialized = resolve; });
      clients.push(client); return client;
    } });
    expect(pool.stats().waitingForCapacity).toBe(false);
    const starting = pool.start();
    expect(pool.stats().waitingForCapacity).toBe(true);
    expect(budget.stats()).toMatchObject({ processes: 2, warmProcesses: 1 });
    pool.resize(100);
    await pool.start();
    expect(clients).toHaveLength(1);
    pool.resize(0);
    expect(pool.stats().waitingForCapacity).toBe(false);
    expect(clients[0].killed).toBe(1);
    expect(budget.stats().processes).toBe(2);
    initialized(); await starting;
    pool.resize(3);
    expect(clients).toHaveLength(1);
    clients[0].exit(); await flush();
    expect(clients).toHaveLength(2);
    expect(budget.stats().processes).toBe(2);
    const lease = await pool.acquire();
    budget.reconfigure({ maxProcesses: 2, maxWarmProcesses: 0, maxQueued: 2 });
    expect(clients[1].killed).toBe(0);
    pool.release(lease);
    expect(clients[1].killed).toBe(1);
    expect(budget.stats().processes).toBe(2);
    pool.close();
    clients[1].exit();
    expect(budget.stats().processes).toBe(1);
    cold.release();
    expect(budget.stats().processes).toBe(0);
  });

  it('releases actual pre-spawn failures but cannot replace a failed bootstrap whose process remains alive', async () => {
    vi.useFakeTimers();
    const budget = createProcessAdmission({ maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 2 });
    let attempts = 0;
    const failed = new FakeClient({ initFails: true, disposeExits: false });
    const healthy = new FakeClient();
    const pool = new MetaSessionPool({ size: 1, processAdmission: budget, replenishDelayMs: 10, createClient: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('spawn failed');
      return attempts === 2 ? failed : healthy;
    } });
    try {
      await expect(pool.start()).rejects.toThrow('spawn failed');
      expect(budget.stats().processes).toBe(0);
      await expect(pool.start()).rejects.toThrow('boot failed');
      expect(budget.stats().processes).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(attempts).toBe(2);
      failed.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(3);
      expect(budget.stats().processes).toBe(1);
      pool.close();
      expect(budget.stats().processes).toBe(0);
    } finally { pool.close(); failed.exit(); vi.useRealTimers(); }
  });

  it('bounds all warm and cold waiters together and removes slots on handoff, cancel and close', async () => {
    const budget = createProcessAdmission({ maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 2 });
    const client = new FakeClient();
    const pool = new MetaSessionPool({ size: 1, processAdmission: budget, createClient: () => client });
    await pool.start();
    const cold = await budget.acquireCold();
    const lease = await pool.acquire();
    const cancel = new AbortController();
    const cancelled = pool.acquire(cancel.signal);
    const cancelledFailure = expect(cancelled).rejects.toThrow();
    const waiting = budget.acquireCold();
    const coldFailure = expect(waiting).rejects.toMatchObject({ reason: 'closed' });
    await expect(pool.acquire()).rejects.toMatchObject({ reason: 'queue-full' });
    cancel.abort(); await cancelledFailure;
    const handoff = pool.acquire();
    pool.release(lease);
    const next = await handoff;
    expect(budget.stats().queued).toBe(1);
    const closing = pool.acquire(new AbortController().signal);
    const closeFailure = expect(closing).rejects.toMatchObject({ reason: 'closed' });
    budget.close();
    await Promise.all([closeFailure, coldFailure]);
    expect(budget.stats().queued).toBe(0);
    expect(budget.stats().processes).toBe(2);
    pool.release(next); pool.close(); cold.release();
    expect(budget.stats().processes).toBe(0);
  });

  it('ignores a stale queue-close callback after handoff without removing another waiting turn', async () => {
    const budget = createProcessAdmission({ maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 2 });
    const callbacks: Array<() => void> = [];
    const pool = new MetaSessionPool({
      size: 1, createClient: () => new FakeClient(),
      processAdmission: { ...budget, reserveQueue: (callback) => { callbacks.push(callback); return budget.reserveQueue(callback); } },
    });
    await pool.start();
    const active = await pool.acquire();
    const handingOff = pool.acquire();
    pool.release(active);
    const granted = await handingOff;
    const waiting = pool.acquire();
    const failure = expect(waiting).rejects.toMatchObject({ reason: 'closed' });
    callbacks[0]();
    expect(budget.stats().queued).toBe(1);
    budget.close(); await failure;
    pool.release(granted); pool.close();
  });
});

describe('immutable physical warm attempts', () => {
  const physical = () => {
    let id = 0;
    return createMetaOperationPhysicalOwnership({ newOwnerId: () => `owner-${++id}` });
  };

  it('registers the adapter operation before enqueue and never kills a safely released client reused by another operation', async () => {
    const ownership = physical();
    const attempts: MetaOperationPhysicalOwner[] = [];
    const registration = { newOwnerId: ownership.newOwnerId, register: (id: string, owner: MetaOperationPhysicalOwner) => {
      attempts.push(owner); ownership.register(id, owner);
    } };
    const clients: FakeClient[] = [];
    let finishSecond!: (result: AcpTurnResult) => void;
    const pool = new MetaSessionPool({ size: 1, physicalOwnership: registration, createClient: () => {
      const client = new FakeClient({ run: async (request) => request.prompt === 'second'
        ? new Promise<AcpTurnResult>((resolve) => { finishSecond = resolve; })
        : { text: 'ok', sessionId: 's', stopReason: 'end_turn', usage: null } });
      clients.push(client); return client;
    } });
    await pool.start();
    const adapter = createAcpMetaRunner({ pool, newSessionId: () => 'application-session', providerId: 'copilot', defaultModel: () => 'auto' });
    ownership.begin('one'); ownership.expect('one');
    expect(await adapter.runDetailed({ operationId: 'one', featureId: 'f', prompt: 'first' })).toMatchObject({ sessionId: 'application-session' });
    ownership.begin('two'); ownership.expect('two');
    const second = adapter.runDetailed({ operationId: 'two', featureId: 'other', prompt: 'second' });
    await flush();
    expect(await ownership.quiesce('one', 100)).toBe('confirmed');
    expect(await attempts[0].quiesce(0)).toBe('released');
    expect(clients[0].killed).toBe(0);
    finishSecond({ text: 'second', sessionId: 's', stopReason: 'end_turn', usage: null });
    await second;
    await ownership.seal('one'); await ownership.seal('two');
    await expect(adapter.runDetailed({ operationId: 'not-admitted', featureId: 'f', prompt: 'blocked' })).rejects.toThrow('not admitted');
    expect(clients[0].turns).toHaveLength(2);
    pool.close();
  });

  it('links real recording/SQLite to native cancellation and retains full isolated results before scoped purge', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const operations = createMetaOperationRepo(db);
    const native = physical();
    const ownership = createMetaOperationOwnership({ physical: native });
    const clients: FakeClient[] = [];
    const pool = new MetaSessionPool({ size: 1, physicalOwnership: native, terminationGraceMs: 1, createClient: () => {
      const client = new FakeClient({ disposeExits: false, run: async (request) => request.prompt === 'hang'
        ? new Promise<AcpTurnResult>(() => {})
        : { text: request.prompt.repeat(1200), sessionId: 'shared-provider-session', stopReason: 'end_turn', usage: null } });
      clients.push(client); return client;
    } });
    let id = 0; let session = 0;
    const adapter = createAcpMetaRunner({ pool, newSessionId: () => `app-${++session}`, providerId: 'copilot', defaultModel: () => 'auto' });
    const runner = createRecordingMetaRunner({
      base: { runDetailed: adapter.runDetailed, run: async (request) => (await adapter.runDetailed(request)).text },
      operations, ownership, clock: createClock(), newOperationId: () => `op-${++id}`,
      resolveIdentity: () => ({ providerId: 'copilot', requestedModel: 'auto' }),
    });
    try {
      await pool.start();
      for (const prompt of ['A', 'B']) {
        const result = await runner.runDetailed({ featureId: 'f', prompt });
        expect(operations.get(result.operationId!)).toMatchObject({ state: 'completed', resultText: prompt.repeat(1200) });
      }
      expect(operations.get('op-1')?.sessionId).not.toBe(operations.get('op-2')?.sessionId);
      const running = runner.runDetailed({ featureId: 'f', originSessionId: 'origin', automationId: 'automation', prompt: 'hang' });
      const failure = expect(running).rejects.toMatchObject({ termination: 'unconfirmed' });
      await flush();
      expect(await ownership.quiesceSession('origin', 5)).toBe(false);
      await failure;
      expect(operations.get('op-3')).toMatchObject({ state: 'interrupted', outcome: 'unknown' });
      expect(clients[1].killed).toBe(0);
      clients[0].exit();
      expect(await ownership.quiesceAutomation('automation', 100)).toBe(true);
      expect(await ownership.quiesceFeature('f', 100)).toBe(true);
      operations.deleteByFeature('f');
      expect(operations.get('op-3')).toBeNull();
      expect(clients[1].killed).toBe(0);
    } finally {
      pool.close(); clients.forEach((client) => client.exit()); db.close();
    }
  });

  it('handles already cancelled requests and cancellation reentrancy during dispatch against the exact lease', async () => {
    const ownership = physical();
    const controller = new AbortController(); controller.abort();
    const pool = new MetaSessionPool({ size: 1, physicalOwnership: ownership, createClient: () => new FakeClient({
      run: async () => {
        void ownership.quiesce('during-dispatch', 100);
        return { text: 'not published', sessionId: 's', stopReason: 'end_turn', usage: null };
      },
    }) });
    await pool.start();
    ownership.begin('preflight'); ownership.expect('preflight');
    await expect(pool.run({ prompt: 'cancelled', signal: controller.signal }, { operationId: 'preflight' })).rejects.toThrow();
    expect(await ownership.seal('preflight')).toBe('confirmed');
    ownership.begin('during-dispatch'); ownership.expect('during-dispatch');
    await expect(pool.run({ prompt: 'cancelled in native dispatch' }, { operationId: 'during-dispatch' }))
      .rejects.toMatchObject({ termination: 'confirmed' });
    expect(await ownership.seal('during-dispatch')).toBe('confirmed');
    pool.close();
  });

  it('proves queued cancellation was not dispatched without killing the unrelated busy lease', async () => {
    const ownership = physical();
    const client = new FakeClient();
    const pool = new MetaSessionPool({ size: 1, physicalOwnership: ownership, createClient: () => client });
    await pool.start();
    const unrelated = await pool.acquire();
    ownership.begin('queued'); ownership.expect('queued');
    const running = pool.run({ prompt: 'never dispatched' }, { operationId: 'queued' });
    const failed = expect(running).rejects.toThrow();
    expect(await ownership.quiesce('queued', 100)).toBe('confirmed');
    await failed;
    expect(client.killed).toBe(0); expect(client.turns).toEqual([]);
    await ownership.seal('queued');
    pool.release(unrelated); pool.close();
  });

  it('retains a cancelled quarantined lease until its exact client exits, independently of its replacement', async () => {
    const ownership = physical();
    const clients: FakeClient[] = [];
    const pool = new MetaSessionPool({ size: 1, physicalOwnership: ownership, terminationGraceMs: 1, createClient: () => {
      const client = new FakeClient({ disposeExits: false, run: async () => new Promise(() => {}) });
      clients.push(client); return client;
    } });
    await pool.start();
    ownership.begin('op'); ownership.expect('op');
    const controller = new AbortController();
    const running = pool.run({ prompt: 'active', signal: controller.signal }, { operationId: 'op' });
    await flush();
    const failed = expect(running).rejects.toMatchObject({ termination: 'unconfirmed' });
    expect(await ownership.quiesce('op', 5)).toBe('unconfirmed');
    await failed;
    const sealed = ownership.seal('op');
    expect(clients[0].killed).toBeGreaterThan(0);
    expect(clients[1].killed).toBe(0);
    clients[0].exit();
    await expect(sealed).resolves.toBe('confirmed');
    expect(clients[1].killed).toBe(0);
    pool.close(); clients.forEach((client) => client.exit());
  });

  it('retains failed fallback attempts and makes no dispatch after start publication cancels', async () => {
    const ownership = physical();
    const clients: FakeClient[] = [];
    const pool = new MetaSessionPool({ size: 1, physicalOwnership: ownership, createClient: () => {
      const client = new FakeClient({ disposeExits: false, run: async () => { throw new Error('provider failed'); } });
      clients.push(client); return client;
    } });
    await pool.start();
    ownership.begin('failure'); ownership.expect('failure');
    await expect(pool.run({ prompt: 'failed' }, { operationId: 'failure' })).rejects.toThrow('provider failed');
    expect(await ownership.quiesce('failure', 0)).toBe('unconfirmed');
    const failed = ownership.seal('failure');
    clients[0].exit(); await failed;
    const controller = new AbortController();
    ownership.begin('cancel'); ownership.expect('cancel');
    await expect(pool.run({ prompt: 'not sent', signal: controller.signal, onStart: () => controller.abort() }, { operationId: 'cancel' }))
      .rejects.toMatchObject({ termination: 'not-started' });
    expect(clients[1].turns).toEqual([]);
    expect(await ownership.seal('cancel')).toBe('confirmed');
    pool.close(); clients.forEach((client) => client.exit());
  });
});

function harness(options: FakeOptions = {}) {
  const created: FakeClient[] = [];
  const pool = new MetaSessionPool({
    size: 1,
    createClient: () => {
      const client = new FakeClient(options);
      created.push(client);
      return client;
    },
  });
  return { pool, created };
}

describe('MetaSessionPool', () => {
  it('warms to the configured size on start', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 3,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    expect(created).toHaveLength(3);
    expect(pool.idleCount).toBe(3);
  });

  it('leases an idle session and returns it on release', async () => {
    const { pool, created } = harness();
    await pool.start();
    const lease = await pool.acquire();
    expect(lease.client).toBe(created[0]);
    expect(pool.idleCount).toBe(0);
    pool.release(lease);
    expect(pool.idleCount).toBe(1);
  });

  it('queues acquire when all sessions are busy and resolves on release', async () => {
    const { pool, created } = harness();
    await pool.start();
    const first = await pool.acquire();
    let served: PooledClient | null = null;
    const pending = pool.acquire().then((c) => {
      served = c.client;
    });
    await flush();
    expect(served).toBeNull();
    pool.release(first);
    await pending;
    expect(served).toBe(created[0]);
  });

  it('rejects a queued acquire when its signal is aborted', async () => {
    const { pool } = harness();
    await pool.start();
    const lease = await pool.acquire();
    const controller = new AbortController();
    const pending = pool.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Meta request cancelled before it started');
    pool.release(lease);
  });

  it('run leases, runs a turn, and releases', async () => {
    const { pool, created } = harness();
    await pool.start();
    const result = await pool.run({ prompt: 'hello' });
    expect(result.text).toBe('ok');
    expect(created[0].turns).toHaveLength(1);
    expect(created[0].turns[0]).toMatchObject({ prompt: 'hello' });
    expect(pool.idleCount).toBe(1);
  });

  it('records a successful warm turn even when deadline tracking is enabled', async () => {
    const { pool } = harness();
    await pool.start();
    await expect(pool.run({ prompt: 'hello', timeoutMs: 50 })).resolves.toMatchObject({
      text: 'ok',
    });
  });

  it('honors an incoming absolute deadline without restarting the budget', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const created: FakeClient[] = [];
      const pool = new MetaSessionPool({
        size: 1,
        now: () => now,
        createClient: () => {
          const client = new FakeClient();
          created.push(client);
          return client;
        },
      });
      await pool.start();
      const busy = await pool.acquire();
      const pending = pool.run({ prompt: 'hello', timeoutMs: 50, deadlineAt: 10 });
      pending.catch(() => undefined);
      await Promise.resolve();
      now = 10;
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).rejects.toMatchObject({
        name: 'MetaAbortError',
        kind: 'timed_out',
        termination: 'not-started',
      });
      expect(created[0].turns).toHaveLength(0);
      pool.release(busy);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls onStart once a queued warm run actually acquires a lease', async () => {
    const { pool } = harness();
    await pool.start();
    const busy = await pool.acquire();
    const onStart = vi.fn();
    const pending = pool.run({ prompt: 'hello', onStart });
    await flush();
    expect(onStart).not.toHaveBeenCalled();
    pool.release(busy);
    await pending;
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('aborts a queued warm run even when no timeout controller is active', async () => {
    const { pool } = harness();
    await pool.start();
    const busy = await pool.acquire();
    const controller = new AbortController();
    const pending = pool.run({ prompt: 'hello', signal: controller.signal });
    pending.catch(() => undefined);
    await flush();
    controller.abort();
    await expect(pending).rejects.toThrow('Meta request cancelled before it started');
    pool.release(busy);
  });

  it('aborts a queued warm run through the deadline controller when both signal and timeout are present', async () => {
    const { pool } = harness();
    await pool.start();
    const busy = await pool.acquire();
    const controller = new AbortController();
    const pending = pool.run({
      prompt: 'hello',
      signal: controller.signal,
      timeoutMs: 50,
    });
    pending.catch(() => undefined);
    await flush();
    controller.abort();
    await expect(pending).rejects.toThrow('Meta request cancelled before it started');
    pool.release(busy);
  });

  it('does not start a warm turn when the request signal is already aborted', async () => {
    const { pool, created } = harness();
    await pool.start();
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run({ prompt: 'hello', signal: controller.signal }),
    ).rejects.toThrow('Meta request cancelled before it started');
    expect(created[0].turns).toHaveLength(0);
    expect(pool.idleCount).toBe(1);
  });

  it('returns a leased client when cancellation lands immediately after queue handoff', async () => {
    const { pool } = harness();
    await pool.start();
    const lease = await pool.acquire();
    const controller = new AbortController();
    const pending = pool.run({ prompt: 'hello', signal: controller.signal });
    pending.catch(() => undefined);
    await flush();
    pool.release(lease);
    controller.abort();
    await expect(pending).rejects.toThrow(
      'Meta request cancelled before it started',
    );
    expect(pool.idleCount).toBe(1);
  });

  it('returns a leased client when the deadline expires immediately after queue handoff', async () => {
    let now = 0;
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 1,
      now: () => now,
      createClient: () => {
        const client = new FakeClient();
        created.push(client);
        return client;
      },
    });
    await pool.start();
    const lease = await pool.acquire();
    const pending = pool.run({ prompt: 'hello', timeoutMs: 10 });
    pending.catch(() => undefined);
    await flush();
    pool.release(lease);
    now = 11;
    await expect(pending).rejects.toThrow(
      'Provider timed out after 10ms before it started',
    );
    expect(created[0].turns).toHaveLength(0);
    expect(pool.idleCount).toBe(1);
  });

  it('times out before dispatch when the deadline expires while waiting for a lease', async () => {
    vi.useFakeTimers();
    try {
      const { pool } = harness();
      await pool.start();
      const lease = await pool.acquire();
      const pending = pool.run({ prompt: 'hello', timeoutMs: 10 });
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).rejects.toThrow(
        'Provider timed out after 10ms before it started',
      );
      pool.release(lease);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the session even when the turn throws', async () => {
    const { pool } = harness({ run: () => Promise.reject(new Error('turn boom')) });
    await pool.start();
    await expect(pool.run({ prompt: 'x' })).rejects.toThrow('turn boom');
    expect(pool.idleCount).toBe(1);
  });

  it('surfaces turn failures even when timeout wrapping is active', async () => {
    const { pool } = harness({ run: () => Promise.reject(new Error('turn boom')) });
    await pool.start();
    await expect(pool.run({ prompt: 'x', timeoutMs: 50 })).rejects.toThrow(
      'turn boom',
    );
  });

  it('cancels an in-flight warm turn and suppresses its eventual result', async () => {
    vi.useFakeTimers();
    try {
      let resolveTurn: (result: AcpTurnResult) => void = () => undefined;
      const { pool, created } = harness({
        disposeExits: false,
        run: () =>
          new Promise((resolve) => {
            resolveTurn = resolve;
          }),
      });
      await pool.start();
      const controller = new AbortController();
      const run = pool.run({ prompt: 'hello', signal: controller.signal });
      run.catch(() => undefined);
      await Promise.resolve();
      controller.abort();
      resolveTurn({
        text: 'late',
        sessionId: 's',
        stopReason: 'end_turn',
        usage: null,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(run).rejects.toThrow(
        'Meta request cancelled; termination was requested but not confirmed',
      );
      expect(created[0].killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses a late warm-turn failure once cancellation is already pending', async () => {
    vi.useFakeTimers();
    try {
      let rejectTurn: (error: Error) => void = () => undefined;
      const { pool } = harness({
        disposeExits: false,
        run: () =>
          new Promise<AcpTurnResult>((_resolve, reject) => {
            rejectTurn = reject;
          }),
      });
      await pool.start();
      const controller = new AbortController();
      const run = pool.run({ prompt: 'hello', signal: controller.signal });
      run.catch(() => undefined);
      await Promise.resolve();
      controller.abort();
      rejectTurn(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(run).rejects.toMatchObject({
        name: 'MetaAbortError',
        kind: 'aborted',
        termination: 'unconfirmed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms cancellation immediately when disposal exits the client synchronously', async () => {
    const { pool, created } = harness({
      run: () => new Promise<AcpTurnResult>(() => undefined),
    });
    await pool.start();
    const controller = new AbortController();
    const run = pool.run({ prompt: 'hello', signal: controller.signal });
    run.catch(() => undefined);
    await Promise.resolve();
    controller.abort();
    await expect(run).rejects.toMatchObject({
      name: 'MetaAbortError',
      kind: 'aborted',
      termination: 'confirmed',
    });
    expect(created[0].killed).toBe(1);
  });

  it('ignores a late exit after cancellation already timed out waiting for confirmation', async () => {
    vi.useFakeTimers();
    try {
      const { pool, created } = harness({
        disposeExits: false,
        run: () => new Promise<AcpTurnResult>(() => undefined),
      });
      await pool.start();
      const controller = new AbortController();
      const run = pool.run({ prompt: 'hello', signal: controller.signal });
      run.catch(() => undefined);
      await Promise.resolve();
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(run).rejects.toMatchObject({
        name: 'MetaAbortError',
        kind: 'aborted',
        termination: 'unconfirmed',
      });
      created[0].exit();
      created[0].exit();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a signal that is already aborted when turn execution starts as an in-flight cancellation', async () => {
    const controller = new AbortController();
    const { pool } = harness({
      run: () => {
        controller.abort();
        return new Promise<AcpTurnResult>(() => undefined);
      },
    });
    await pool.start();
    const run = pool.run({ prompt: 'hello', signal: controller.signal });
    run.catch(() => undefined);
    await expect(run).rejects.toMatchObject({
      name: 'MetaAbortError',
      kind: 'aborted',
    });
  });

  it('keeps the first stop reason if the turn times out after a cancellation is already pending', async () => {
    vi.useFakeTimers();
    try {
      const { pool } = harness({
        disposeExits: false,
        run: () => new Promise<AcpTurnResult>(() => undefined),
      });
      await pool.start();
      const controller = new AbortController();
      const run = pool.run({
        prompt: 'hello',
        signal: controller.signal,
        timeoutMs: 5,
      });
      run.catch(() => undefined);
      await Promise.resolve();
      controller.abort();
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(995);
      await expect(run).rejects.toMatchObject({
        name: 'MetaAbortError',
        kind: 'aborted',
        termination: 'unconfirmed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a timeout callback that fires after waitForExit already settled', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    try {
      const pool = new MetaSessionPool({
        size: 0,
        terminationGraceMs: 1_000,
        createClient: () => new FakeClient(),
      });
      const client = new FakeClient();
      const waitForExit = (
        pool as unknown as { waitForExit: (client: PooledClient) => Promise<boolean> }
      ).waitForExit.bind(pool);
      const promise = waitForExit(client);
      client.exit();
      await expect(promise).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.alive).toBe(false);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports confirmed timeout termination once the disposed client exits', async () => {
    vi.useFakeTimers();
    try {
      const { pool, created } = harness({
        disposeExits: false,
        run: () => new Promise<AcpTurnResult>(() => undefined),
      });
      await pool.start();
      const run = pool.run({ prompt: 'hello', timeoutMs: 10 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      created[0].exit();
      await expect(run).rejects.toMatchObject({
        name: 'MetaAbortError',
        termination: 'confirmed',
        message: 'Provider timed out after 10ms',
      });
      expect(created[0].killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replenishes when an idle session exits', async () => {
    const { pool, created } = harness();
    await pool.start();
    expect(created).toHaveLength(1);
    created[0].exit();
    await flush();
    expect(created).toHaveLength(2);
    expect(pool.idleCount).toBe(1);
  });

  it('serves a waiter with a replenished session after a leased one exits', async () => {
    const { pool, created } = harness();
    await pool.start();
    const leased = await pool.acquire();
    let served: PooledClient | null = null;
    const pending = pool.acquire().then((c) => {
      served = c.client;
    });
    await flush();
    expect(served).toBeNull();
    (leased.client as FakeClient).exit();
    await flush();
    await pending;
    expect(served).toBe(created[1]);
  });

  it('removes a served waiter abort listener before handing it the lease', async () => {
    const { pool } = harness();
    await pool.start();
    const first = await pool.acquire();
    const controller = new AbortController();
    const pending = pool.acquire(controller.signal);
    pool.release(first);
    const second = await pending;
    controller.abort();
    pool.release(second);
    expect(pool.idleCount).toBe(1);
  });

  it('does not re-add a dead session on release', async () => {
    const { pool } = harness();
    await pool.start();
    const lease = await pool.acquire();
    (lease.client as FakeClient).alive = false;
    pool.release(lease);
    expect(pool.idleCount).toBe(0);
  });

  it('ignores duplicate releases so one client is never leased twice concurrently', async () => {
    const { pool, created } = harness();
    await pool.start();
    const first = await pool.acquire();
    const secondLeasePromise = pool.acquire();
    await flush();
    pool.release(first);
    const second = await secondLeasePromise;
    expect(second.client).toBe(created[0]);

    let thirdResolved = false;
    const thirdLeasePromise = pool.acquire().then((lease) => {
      thirdResolved = true;
      return lease;
    });
    await flush();
    pool.release(first);
    await flush();
    expect(thirdResolved).toBe(false);

    pool.release(second);
    const third = await thirdLeasePromise;
    expect(third.client).toBe(created[0]);
    pool.release(third);
  });

  it('rejects acquire and pending waiters when closed', async () => {
    const { pool, created } = harness();
    await pool.start();
    const busy = await pool.acquire();
    const waiter = pool.acquire();
    pool.close();
    expect(created[0].killed).toBe(1);
    await expect(waiter).rejects.toThrow('MetaSessionPool is closed');
    await expect(pool.acquire()).rejects.toThrow('MetaSessionPool is closed');
    pool.release(busy);
  });

  it('removes waiter abort listeners when the pool is closed', async () => {
    const { pool } = harness();
    await pool.start();
    const busy = await pool.acquire();
    const controller = new AbortController();
    const waiter = pool.acquire(controller.signal);
    pool.close();
    controller.abort();
    await expect(waiter).rejects.toThrow('MetaSessionPool is closed');
    pool.release(busy);
    expect(pool.idleCount).toBe(0);
  });

  it('disposes idle sessions on close', async () => {
    const { pool, created } = harness();
    await pool.start();
    pool.close();
    expect(created[0].killed).toBe(1);
  });

  it('closeAndWait stays pending until a disposed session actually exits', async () => {
    const { pool, created } = harness({ disposeExits: false });
    await pool.start();
    const pending = pool.closeAndWait(5);
    expect(created[0].killed).toBe(1);
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending');
    created[0].exit();
    await expect(pending).resolves.toBe(true);
  });

  it('closeAndWait resolves immediately when the pool is already empty', async () => {
    const pool = new MetaSessionPool({
      size: 0,
      createClient: () => new FakeClient(),
    });
    await expect(pool.closeAndWait(5)).resolves.toBe(true);
  });

  it('ignores a later close notification after closeAndWait already timed out', async () => {
    vi.useFakeTimers();
    try {
      const { pool, created } = harness({ disposeExits: false });
      await pool.start();
      const pending = pool.closeAndWait(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(false);
      created[0].exit();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a later timeout callback after closeAndWait already resolved', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    try {
      const { pool, created } = harness({ disposeExits: false });
      await pool.start();
      const pending = pool.closeAndWait(1);
      created[0].exit();
      await expect(pending).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('surfaces initialization failures from start', async () => {
    const { pool } = harness({ initFails: true });
    await expect(pool.start()).rejects.toThrow('boot failed');
  });

  it('retries a synchronous createClient failure on a bounded delay without spinning', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const created: FakeClient[] = [];
      const pool = new MetaSessionPool({
        size: 1,
        replenishDelayMs: 50,
        createClient: () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('spawn failed');
          }
          const client = new FakeClient();
          created.push(client);
          return client;
        },
      });

      await expect(pool.start()).rejects.toThrow('spawn failed');
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(attempts).toBe(2);
      expect(created).toHaveLength(1);
      expect(pool.idleCount).toBe(1);
      pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed initialize on a bounded delay and recovers capacity', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const created: FakeClient[] = [];
      const pool = new MetaSessionPool({
        size: 1,
        replenishDelayMs: 50,
        createClient: () => {
          attempts += 1;
          const client = new FakeClient({
            initFails: attempts === 1,
            disposeExits: false,
          });
          created.push(client);
          return client;
        },
      });

      await expect(pool.start()).rejects.toThrow('boot failed');
      expect(attempts).toBe(1);
      expect(created[0].killed).toBe(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(attempts).toBe(2);
      expect(pool.idleCount).toBe(1);
      expect(pool.stats().live).toBe(2);
      created[0].exit();
      await Promise.resolve();
      expect(pool.stats().live).toBe(1);
      pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a queued replenish retry when closed', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const pool = new MetaSessionPool({
        size: 1,
        replenishDelayMs: 50,
        createClient: () => {
          attempts += 1;
          throw new Error('spawn failed');
        },
      });

      await expect(pool.start()).rejects.toThrow('spawn failed');
      expect(attempts).toBe(1);
      pool.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not queue duplicate replenish timers while one retry is already pending', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const pool = new MetaSessionPool({
        size: 1,
        replenishDelayMs: 50,
        createClient: () => {
          attempts += 1;
          throw new Error('spawn failed');
        },
      });

      await expect(pool.start()).rejects.toThrow('spawn failed');
      expect(attempts).toBe(1);
      (
        pool as unknown as {
          ensureTargetSize(delayMs?: number): void;
        }
      ).ensureTargetSize(50);
      await vi.advanceTimersByTimeAsync(50);
      expect(attempts).toBe(2);
      pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawns nothing when start runs after close', async () => {
    const { pool, created } = harness();
    pool.close();
    await pool.start();
    expect(created).toHaveLength(0);
    expect(pool.idleCount).toBe(0);
  });

  it('reports readiness and warm-capacity stats', async () => {
    const pool = new MetaSessionPool({
      size: 2,
      now: () => 5000,
      createClient: () => new FakeClient(),
    });
    expect(pool.ready).toBe(false);
    expect(pool.stats()).toEqual({
      size: 2,
      live: 0,
      idle: 0,
      busy: 0,
      ready: false,
      served: 0,
      sessions: [],
    });
    await pool.start();
    expect(pool.ready).toBe(true);
    const leased = await pool.acquire();
    const stats = pool.stats();
    expect(stats).toMatchObject({
      size: 2,
      live: 2,
      idle: 1,
      busy: 1,
      ready: true,
      served: 0,
    });
    expect(stats.sessions).toEqual([
      {
        id: 's1',
        state: 'busy',
        served: 0,
        startedAt: 5000,
        lastActiveAt: 5000,
        inputTokens: 0,
        outputTokens: 0,
        history: [],
      },
      {
        id: 's2',
        state: 'idle',
        served: 0,
        startedAt: 5000,
        lastActiveAt: null,
        inputTokens: 0,
        outputTokens: 0,
        history: [],
      },
    ]);
    pool.release(leased);
    expect(pool.stats().sessions[0].state).toBe('idle');
    pool.close();
    expect(pool.ready).toBe(false);
  });

  it('exposes per-session served counts and warming state', async () => {
    let now = 100;
    const pool = new MetaSessionPool({
      size: 1,
      now: () => now,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    now = 200;
    await pool.run({ prompt: 'one' });
    const [session] = pool.stats().sessions;
    expect(session).toEqual({
      id: 's1',
      state: 'idle',
      served: 1,
      startedAt: 100,
      lastActiveAt: 200,
      inputTokens: 0,
      outputTokens: 0,
      history: [
        {
          at: 200,
          purpose: 'general',
          prompt: 'one',
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    });
    pool.close();
  });

  it('shows a session as warming until it finishes booting', async () => {
    let resolveInit: () => void = () => undefined;
    const client = new FakeClient();
    client.initialize = () =>
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
    const pool = new MetaSessionPool({
      size: 1,
      now: () => 1,
      createClient: () => client,
    });
    const starting = pool.start();
    await flush();
    expect(pool.stats().sessions).toEqual([
      {
        id: 's1',
        state: 'warming',
        served: 0,
        startedAt: 1,
        lastActiveAt: null,
        inputTokens: 0,
        outputTokens: 0,
        history: [],
      },
    ]);
    resolveInit();
    await starting;
    expect(pool.stats().sessions[0].state).toBe('idle');
    pool.close();
  });

  it('disposes a warming client that becomes unusable before initialize finishes', async () => {
    let resolveInit: () => void = () => undefined;
    const client = new FakeClient({ disposeExits: false });
    client.initialize = () =>
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => client,
    });
    const starting = pool.start();
    await flush();
    client.reusable = false;
    resolveInit();
    await starting;
    expect(client.killed).toBe(1);
    expect(pool.stats().live).toBe(1);
    client.exit();
    await flush();
    expect(pool.stats().live).toBe(0);
    pool.close();
  });

  it('warms sessions sequentially instead of spawning multiple warming clients at once', async () => {
    let resolveFirst: () => void = () => undefined;
    const first = new FakeClient({ disposeExits: false });
    first.initialize = () =>
      new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    const second = new FakeClient({ disposeExits: false });
    const queue = [first, second];
    const pool = new MetaSessionPool({
      size: 2,
      createClient: () => queue.shift() ?? new FakeClient(),
    });
    const starting = pool.start();
    await flush();
    expect(pool.stats().sessions.map((session) => session.state)).toEqual(['warming']);
    resolveFirst();
    await flush();
    expect(pool.stats().sessions.map((session) => session.state)).toEqual(['idle', 'idle']);
    await starting;
    expect(pool.idleCount).toBe(2);
    pool.close();
  });

  it('retires a warming session immediately when the pool is shrunk below it', async () => {
    let resolveInit: () => void = () => undefined;
    const client = new FakeClient({ disposeExits: false });
    client.initialize = () =>
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => client,
    });
    const starting = pool.start();
    await flush();
    pool.resize(0);
    expect(client.killed).toBe(1);
    resolveInit();
    await starting;
    client.exit();
  });

  it('keeps closed busy and warming sessions counted until they actually exit', async () => {
    let resolveInit: () => void = () => undefined;
    let resolveBusy: () => void = () => undefined;
    const warming = new FakeClient({ disposeExits: false });
    warming.initialize = () =>
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
    const busy = new FakeClient({
      disposeExits: false,
      run: () =>
        new Promise((resolve) => {
          resolveBusy = () =>
            resolve({
              text: 'ok',
              sessionId: 's',
              stopReason: 'end_turn',
              usage: null,
            });
        }),
    });
    const queue = [busy, warming];
    const pool = new MetaSessionPool({
      size: 2,
      createClient: () => queue.shift() ?? new FakeClient(),
    });
    const starting = pool.start();
    await flush();
    const turn = pool.run({ prompt: 'x' });
    await flush();
    pool.close();
    const closed = pool.stats();
    expect(closed.ready).toBe(false);
    expect(closed.size).toBe(0);
    expect(closed.live).toBe(2);
    expect(busy.killed).toBe(1);
    expect(warming.killed).toBe(1);
    resolveBusy();
    resolveInit();
    busy.exit();
    warming.exit();
    await expect(turn).resolves.toMatchObject({ text: 'ok' });
    await starting;
    expect(pool.stats().live).toBe(0);
  });

  it('drops a session that exits mid-turn without double-counting it', async () => {
    const first = new FakeClient({
      run: async () => {
        first.exit();
        return { text: 'ok', sessionId: 's', stopReason: 'end_turn', usage: null };
      },
    });
    const queue: FakeClient[] = [first, new FakeClient()];
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => queue.shift() ?? new FakeClient(),
    });
    await pool.start();
    const result = await pool.run({ prompt: 'x' });
    expect(result.text).toBe('ok');
    // Aggregate still counts the served turn, but the exited session is gone.
    expect(pool.stats().served).toBe(1);
    expect(pool.stats().sessions.every((s) => s.id !== 's1')).toBe(true);
    pool.close();
  });

  it('counts each successfully served warm turn', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    expect(pool.stats().served).toBe(0);
    await pool.run({ prompt: 'one' });
    await pool.run({ prompt: 'two' });
    expect(pool.stats().served).toBe(2);
    pool.close();
  });

  it('records per-turn token usage and a capped usage history', async () => {
    let now = 1000;
    let tokens = 10;
    const pool = new MetaSessionPool({
      size: 1,
      now: () => now,
      createClient: () =>
        new FakeClient({
          run: () =>
            Promise.resolve({
              text: 'ok',
              sessionId: 's',
              stopReason: 'end_turn',
              usage: { inputTokens: tokens, outputTokens: tokens * 2 },
            }),
        }),
    });
    await pool.start();
    now = 1100;
    tokens = 10;
    await pool.run(
      { prompt: 'a' },
      { purpose: 'pr-review', label: 'PR review · problem statement' },
    );
    now = 1200;
    tokens = 5;
    await pool.run({ prompt: 'b' });
    const [session] = pool.stats().sessions;
    expect(session.inputTokens).toBe(15);
    expect(session.outputTokens).toBe(30);
    expect(session.history).toEqual([
      {
        at: 1100,
        purpose: 'pr-review',
        label: 'PR review · problem statement',
        prompt: 'a',
        inputTokens: 10,
        outputTokens: 20,
      },
      {
        at: 1200,
        purpose: 'general',
        prompt: 'b',
        inputTokens: 5,
        outputTokens: 10,
      },
    ]);
    pool.close();
  });

  it('caps the history to the most recent turns', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    for (let i = 0; i < 30; i += 1) {
      await pool.run({ prompt: `turn-${i}` });
    }
    const [session] = pool.stats().sessions;
    expect(session.served).toBe(30);
    expect(session.history).toHaveLength(25);
    pool.close();
  });

  it('returns a defensive copy of a session history', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    await pool.run({ prompt: 'a' });
    const history = pool.stats().sessions[0].history;
    history.push({ at: 0, purpose: 'x', inputTokens: 9, outputTokens: 9 });
    expect(pool.stats().sessions[0].history).toHaveLength(1);
    pool.close();
  });

  it('exposes the in-flight conversation and clears it when the turn ends', async () => {
    let release: (result: AcpTurnResult) => void = () => undefined;
    const forwarded: string[] = [];
    const pool = new MetaSessionPool({
      size: 1,
      now: () => 42,
      createClient: () =>
        new FakeClient({
          run: (request) => {
            request.onActivity?.('Hello');
            request.onActivity?.(' world');
            return new Promise<AcpTurnResult>((resolve) => {
              release = resolve;
            });
          },
        }),
    });
    await pool.start();
    const turn = pool.run(
      { prompt: 'diagnose', onActivity: (text) => forwarded.push(text) },
      { purpose: 'self-recovery', label: 'Self-recovery diagnosis' },
    );
    await flush();
    const [busy] = pool.stats().sessions;
    expect(busy.state).toBe('busy');
    expect(busy.live).toEqual({
      purpose: 'self-recovery',
      label: 'Self-recovery diagnosis',
      prompt: 'diagnose',
      response: 'Hello world',
      startedAt: 42,
    });
    // The pool observes the raw chunks but still forwards them to the caller.
    expect(forwarded).toEqual(['Hello', ' world']);
    release({
      text: 'Hello world',
      sessionId: 's',
      stopReason: 'end_turn',
      usage: null,
    });
    await turn;
    const [idle] = pool.stats().sessions;
    expect(idle.live).toBeUndefined();
    expect(idle.history).toEqual([
      {
        at: 42,
        purpose: 'self-recovery',
        label: 'Self-recovery diagnosis',
        prompt: 'diagnose',
        response: 'Hello world',
        inputTokens: 0,
        outputTokens: 0,
      },
    ]);
    pool.close();
  });

  it('truncates long prompt and response previews in history', async () => {
    const bigPrompt = 'p'.repeat(2500);
    const bigChunk = 'r'.repeat(13000);
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () =>
        new FakeClient({
          run: (request) => {
            request.onActivity?.(bigChunk);
            return Promise.resolve({
              text: bigChunk,
              sessionId: 's',
              stopReason: 'end_turn',
              usage: null,
            });
          },
        }),
    });
    await pool.start();
    await pool.run({ prompt: bigPrompt });
    const [turn] = pool.stats().sessions[0].history;
    expect(turn.prompt).toBe(`${'p'.repeat(2000)}…`);
    expect(turn.response).toBe(`${'r'.repeat(12000)}…`);
    pool.close();
  });

  it('omits prompt and response previews when the turn carried neither', async () => {
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => new FakeClient(),
    });
    await pool.start();
    await pool.run({ prompt: '' });
    const [turn] = pool.stats().sessions[0].history;
    expect(turn.prompt).toBeUndefined();
    expect(turn.response).toBeUndefined();
    pool.close();
  });

  it('grows the pool live when resized up', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    expect(pool.stats().size).toBe(1);
    pool.resize(3);
    await flush();
    const stats = pool.stats();
    expect(stats.size).toBe(3);
    expect(stats.live).toBe(3);
    expect(stats.idle).toBe(3);
    expect(created).toHaveLength(3);
    pool.close();
  });

  it('shrinks the pool live by retiring idle surplus highest-first', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 3,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    pool.resize(1);
    const stats = pool.stats();
    expect(stats.size).toBe(1);
    expect(stats.live).toBe(1);
    expect(stats.sessions.map((s) => s.id)).toEqual(['s1']);
    // The two highest-numbered idle sessions were killed.
    expect(created[1].killed).toBe(1);
    expect(created[2].killed).toBe(1);
    expect(created[0].killed).toBe(0);
    pool.close();
  });

  it('retires a busy surplus session only when it checks back in', async () => {
    const created: FakeClient[] = [];
    const resolvers: Array<() => void> = [];
    const pool = new MetaSessionPool({
      size: 2,
      createClient: () => {
        const c = new FakeClient({
          run: () =>
            new Promise((resolve) => {
              resolvers.push(() =>
                resolve({
                  text: 'ok',
                  sessionId: 's',
                  stopReason: 'end_turn',
                  usage: null,
                }),
              );
            }),
        });
        created.push(c);
        return c;
      },
    });
    await pool.start();
    // Lease both sessions so they are busy, then shrink to 1: no idle session
    // exists to retire, so live stays 2 until a busy one checks back in.
    const first = pool.run({ prompt: 'a' });
    const second = pool.run({ prompt: 'b' });
    await flush();
    pool.resize(1);
    expect(pool.stats().live).toBe(2);
    expect(created[0].killed).toBe(0);
    pool.resize(1);
    expect(created.map((client) => client.killed)).toEqual([0, 0]);
    resolvers[0]();
    await first;
    // The highest-numbered busy session (s2) was marked surplus, so s1 stays
    // warm when it checks back in and the live count remains truthful until
    // the surplus session actually exits.
    expect(created[0].killed).toBe(0);
    expect(pool.stats().live).toBe(2);
    resolvers[1]();
    await second;
    expect(created[1].killed).toBe(1);
    expect(pool.stats().live).toBe(1);
    pool.close();
  });

  it('replaces a quarantined client after a failed turn without reusing it', async () => {
    const first = new FakeClient({
      run: async () => {
        first.reusable = false;
        return Promise.reject(new Error('ambiguous timeout'));
      },
      disposeExits: false,
    });
    const second = new FakeClient();
    const queue = [first, second];
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => queue.shift() ?? new FakeClient(),
    });
    await pool.start();
    await expect(pool.run({ prompt: 'A' })).rejects.toThrow('ambiguous timeout');
    expect(first.killed).toBe(1);
    await flush();
    expect(pool.stats().live).toBe(2);
    expect(pool.idleCount).toBe(1);
    const result = await pool.run({ prompt: 'B' });
    expect(result.text).toBe('ok');
    expect(first.turns).toHaveLength(1);
    expect(second.turns).toHaveLength(1);
    first.exit();
    await flush();
    expect(pool.stats().live).toBe(1);
    pool.close();
  });

  it('does not double-decrement when a warming client exits during initialize', async () => {
    vi.useFakeTimers();
    try {
      let rejectInit: (error: Error) => void = () => undefined;
      const first = new FakeClient({ disposeExits: false });
      first.initialize = () =>
        new Promise<void>((_resolve, reject) => {
          rejectInit = reject;
        });
      const second = new FakeClient();
      const queue = [first, second];
      const pool = new MetaSessionPool({
        size: 1,
        replenishDelayMs: 50,
        createClient: () => queue.shift() ?? new FakeClient(),
      });
      const starting = pool.start();
      await Promise.resolve();
      expect(pool.stats().live).toBe(1);
      first.exit();
      rejectInit(new Error('boot failed'));
      await expect(starting).rejects.toThrow('boot failed');
      expect(pool.stats().live).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
      expect(pool.stats().live).toBe(1);
      expect(pool.idleCount).toBe(1);
      expect(second.killed).toBe(0);
      pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not respawn after a shrink drops a session below the old size', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 2,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    pool.resize(1);
    // s2 was retired; simulate its process exit — no replacement should spawn.
    created[1].exit();
    await flush();
    expect(created).toHaveLength(2);
    expect(pool.stats().live).toBe(1);
    pool.close();
  });

  it('ignores a resize once the pool is closed', async () => {
    const created: FakeClient[] = [];
    const pool = new MetaSessionPool({
      size: 1,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
    });
    await pool.start();
    pool.close();
    pool.resize(5);
    await flush();
    expect(created).toHaveLength(1);
  });

  it('ignores an exit callback for a client the pool no longer tracks', async () => {
    const { pool, created } = harness();
    await pool.start();
    (
      pool as unknown as {
        handleExit(client: PooledClient): void;
      }
    ).handleExit(new FakeClient());
    expect(created).toHaveLength(1);
    expect(pool.stats().live).toBe(1);
    pool.close();
  });

  it('does not try to replenish after the pool has been closed', async () => {
    const { pool, created } = harness();
    await pool.start();
    pool.close();
    (
      pool as unknown as {
        ensureTargetSize(): void;
      }
    ).ensureTargetSize();
    expect(created).toHaveLength(1);
    expect(pool.stats().size).toBe(0);
  });

  it('retires a checked-in client when the active count is already above target', async () => {
    const { pool, created } = harness({ disposeExits: false });
    await pool.start();
    const lease = await pool.acquire();
    (
      pool as unknown as {
        targetSize: number;
      }
    ).targetSize = 0;
    pool.release(lease);
    expect(created[0].killed).toBe(1);
    expect(pool.stats().live).toBe(1);
    created[0].exit();
    await flush();
    expect(pool.stats().live).toBe(0);
  });

  it('skips spawning when the pool is already at its target size', async () => {
    const { pool, created } = harness();
    await pool.start();
    await (
      pool as unknown as {
        spawn(): Promise<void>;
      }
    ).spawn();
    expect(created).toHaveLength(1);
    pool.close();
  });
});
