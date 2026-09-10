import { describe, it, expect } from 'vitest';
import { createSessionLauncher, type SessionEventMap } from './session-launcher.js';
import { createSessionFactory } from './session-factory.js';
import { sessionDefaults } from './config.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import { createProviderResolver } from '../provider/provider-resolver.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createClock } from '../kernel/clock.js';
import type {
  IAIProvider,
  RunningSession,
  SessionEvent,
  SessionSpec,
} from '../provider/provider-contract.js';
import type { Transcript } from './transcript-capture.js';
import type { Session } from './session-contract.js';
import { createMetaOperationPhysicalOwnership } from '../meta/meta-operation-physical-ownership.js';
import type { MetaOperationPhysicalOwner, MetaOperationPhysicalRegistration } from '../meta/meta-operation-contract.js';
import { createMetaOperationOwnership } from '../meta/meta-operation-ownership.js';
import { createMetaRunner } from '../meta/meta-runner.js';
import { metaDefaults } from '../meta/config.js';
import { createPooledMetaRunner } from '../meta/pooled-meta-runner.js';
import { createAcpMetaRunner } from '../meta/acp/acp-meta-runner.js';
import { MetaSessionPool, type PooledClient } from '../meta/acp/acp-pool.js';
import { AcpRequestError } from '../meta/acp/acp-client.js';
import { createProcessAdmission, type ProcessAdmission } from '../kernel/process-admission.js';

function fakeRunning(killImpl?: () => void) {
  const handlers = new Set<(event: SessionEvent) => void>();
  let resolveDone!: (code: number | null) => void;
  let rejectDone!: (error: Error) => void;
  let kills = 0;
  const done = new Promise<number | null>((r, reject) => {
    resolveDone = r;
    rejectDone = reject;
  });
  const running: RunningSession = {
    sessionId: 'ignored',
    onEvent: (h) => {
      handlers.add(h);
    },
    kill: () => {
      kills += 1;
      killImpl?.();
    },
    done,
  };
  return {
    running,
    emit: (event: SessionEvent) => { for (const handler of handlers) handler(event); },
    finish: (code: number | null) => {
      for (const handler of handlers) handler({ type: 'exit', code });
      resolveDone(code);
    },
    get kills() {
      return kills;
    },
    fail: (error: Error) => rejectDone(error),
  };
}

function harness(options: {
  physicalOwnership?: MetaOperationPhysicalRegistration;
  processAdmission?: ProcessAdmission;
  failSave?: boolean;
  bootstrap?: string;
  readinessError?: Error;
  composeError?: Error;
  readiness?: (featureId: string) => Promise<void>;
  compose?: (session: Session) => Promise<string>;
  onStartSession?: (spec: SessionSpec) => void;
  kill?: () => void;
  save?: (transcript: Transcript) => Promise<void>;
} = {}) {
  const rs = fakeRunning(options.kill);
  let capturedSpec: SessionSpec | undefined;
  const provider: IAIProvider = {
    id: 'copilot',
    listModels: async () => [
      { id: 'auto', label: 'Auto' },
      { id: 'gpt-5.4', label: 'G' },
    ],
    startSession: (spec) => {
      capturedSpec = spec;
      options.onStartSession?.(spec);
      return rs.running;
    },
    buildInteractiveCommand: () => {
      throw new Error('unused');
    },
  };
  const registry = createProviderRegistry();
  registry.register(provider);
  const resolver = createProviderResolver(registry, {
    defaultProvider: 'copilot',
    defaultModelByProvider: {},
  });
  const saved: Transcript[] = [];
  const transcriptStore = {
    save: async (t: Transcript) => {
      await options.save?.(t);
      if (options.failSave) {
        throw new Error('disk full');
      }
      saved.push(t);
    },
    load: async () => null,
    delete: async () => undefined,
  };
  const bus = createEventBus<SessionEventMap>();
  const started: Session[] = [];
  const ended: Session[] = [];
  const outputs: {
    sessionId: string;
    scope: 'feature' | 'internal';
    event: SessionEvent;
  }[] = [];
  const bootstrapCalls: string[] = [];
  bus.on('session.started', (s) => started.push(s));
  bus.on('session.ended', (s) => ended.push(s));
  bus.on('session.output', (o) => outputs.push(o));

  const launcher = createSessionLauncher({
    physicalOwnership: options.physicalOwnership,
    processAdmission: options.processAdmission,
    resolver,
    factory: createSessionFactory({
      ids: createIdGenerator(() => 'sess-1'),
      clock: createClock(() => Date.parse('2025-01-01T00:00:00.000Z')),
      config: sessionDefaults,
    }),
    transcriptStore,
    bus,
    clock: createClock(() => Date.parse('2025-01-01T00:00:05.000Z')),
    config: sessionDefaults,
    bootstrap: {
      assertFeatureReady: async (featureId) => {
        bootstrapCalls.push(`ready:${featureId}`);
        if (options.readiness) {
          await options.readiness(featureId);
          return;
        }
        if (options.readinessError) throw options.readinessError;
      },
      composeForSession: async (session) => {
        bootstrapCalls.push(`compose:${session.id}`);
        if (options.compose) {
          return options.compose(session);
        }
        if (options.composeError) throw options.composeError;
        return session.kind === 'dev' ? (options.bootstrap ?? 'BOOTSTRAP') : '';
      },
    },
  });

  return {
    bus,
    rs,
    launcher,
    saved,
    started,
    ended,
    outputs,
    bootstrapCalls,
    getSpec: () => capturedSpec,
  };
}

describe('cold physical operation ownership', () => {
  it('enforces one shared warm+cold native ceiling and a bounded cancellable acquisition queue', async () => {
    const budget = createProcessAdmission({ maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 1 });
    let exited!: () => void;
    const state = { alive: true, reusable: true };
    const client: PooledClient = {
      get alive() { return state.alive; }, get reusable() { return state.reusable; },
      initialize: async () => {}, runTurn: async () => { throw new Error('unused'); },
      onExit: (handler) => { exited = handler; }, dispose: () => { state.reusable = false; },
    };
    const pool = new MetaSessionPool({ size: 10, processAdmission: budget, createClient: () => client });
    const h = harness({ processAdmission: budget });
    try {
      await pool.start();
      expect(pool.stats().live).toBe(1);
      const launched = await h.launcher.start({ featureId: 'f', prompt: 'cold', kind: 'meta' });
      const controller = new AbortController();
      const queued = h.launcher.start({ featureId: 'f', prompt: 'queued', kind: 'meta', signal: controller.signal });
      const rejected = expect(queued).rejects.toMatchObject({ reason: 'cancelled' });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(h.launcher.start({ featureId: 'f', prompt: 'full', kind: 'meta' })).rejects.toMatchObject({ reason: 'queue-full' });
      expect(h.started).toHaveLength(1);
      expect(budget.stats()).toMatchObject({ processes: 2, queued: 1 });
      controller.abort(); await rejected;
      expect(budget.stats().queued).toBe(0);
      h.rs.finish(0); await launched.completion;
      expect(budget.stats().processes).toBe(1);
      pool.close();
      expect(budget.stats().processes).toBe(1);
      state.alive = false; exited();
      expect(budget.stats().processes).toBe(0);
    } finally { budget.close(); pool.close(); }
  });

  it('holds startup permits through uncancelled bootstrap and releases failed pre-spawn admission', async () => {
    const budget = createProcessAdmission({ maxProcesses: 1, maxWarmProcesses: 0, maxQueued: 1 });
    let release!: () => void;
    const controller = new AbortController();
    const h = harness({ processAdmission: budget, readiness: () => new Promise<void>((resolve) => { release = resolve; }) });
    const start = h.launcher.start({ featureId: 'f', prompt: 'bootstrap', signal: controller.signal });
    const failed = expect(start).rejects.toThrow('cancelled');
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(); await failed;
    expect(budget.stats().processes).toBe(1);
    release(); await h.launcher.waitForIdle(100);
    expect(budget.stats().processes).toBe(0);
    const broken = harness({ processAdmission: budget, onStartSession: () => { throw new Error('spawn failed'); } });
    await expect(broken.launcher.start({ featureId: 'f', prompt: 'failure', kind: 'meta' })).rejects.toThrow('spawn failed');
    expect(budget.stats().processes).toBe(0);
  });

  it('never releases a process permit on rejected completion without native exit', async () => {
    const budget = createProcessAdmission({ maxProcesses: 1, maxWarmProcesses: 0, maxQueued: 1 });
    const h = harness({ processAdmission: budget });
    const launched = await h.launcher.start({ featureId: 'f', prompt: 'go', kind: 'meta' });
    const failed = expect(launched.completion).rejects.toThrow('unknown');
    h.rs.fail(new Error('unknown')); await failed;
    expect(await h.launcher.quiesceFeature('f', 0)).toBe(false);
    expect(budget.stats().processes).toBe(1);
    h.rs.emit({ type: 'exit', code: null });
    expect(await h.launcher.waitForIdle(100)).toBe(true);
    expect(budget.stats().processes).toBe(0);
  });

  it('returns an admitted permit when cancellation wins before bootstrap resumes', async () => {
    const budget = createProcessAdmission({ maxProcesses: 1, maxWarmProcesses: 0, maxQueued: 0 });
    const controller = new AbortController();
    const h = harness({ processAdmission: {
      ...budget,
      acquireCold: async (signal) => {
        const permit = await budget.acquireCold(signal);
        controller.abort();
        return permit;
      },
    } });
    await expect(h.launcher.start({ featureId: 'f', prompt: 'cancelled', signal: controller.signal })).rejects.toThrow('cancelled');
    expect(await h.launcher.waitForIdle(100)).toBe(true);
    expect(h.getSpec()).toBeUndefined();
    expect(budget.stats().processes).toBe(0);
  });

  it.each([false, true])('retains failed warm ownership across real cold fallback (shared budget=%s)', async (bounded) => {
    let id = 0;
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => `native-${++id}` });
    const ownership = createMetaOperationOwnership({ physical });
    const budget = bounded ? createProcessAdmission({ maxProcesses: 2, maxWarmProcesses: 1, maxQueued: 1 }) : undefined;
    const clients: Array<{ exit(): void; state: { alive: boolean; reusable: boolean; kills: number } }> = [];
    const pool = new MetaSessionPool({ size: 1, physicalOwnership: physical, processAdmission: budget, createClient: () => {
      const state = { alive: true, reusable: true, kills: 0 };
      let onExit!: () => void;
      const client: PooledClient = {
        get alive() { return state.alive; }, get reusable() { return state.reusable; },
        initialize: async () => {},
        runTurn: async () => { throw new AcpRequestError('session initialization failed', { method: 'session/new', allowFallbackToCold: true }); },
        onExit: (handler) => { onExit = handler; },
        dispose: () => { state.kills += 1; state.reusable = false; },
      };
      clients.push({ state, exit: () => { state.alive = false; onExit(); } });
      return client;
    } });
    const h = harness({ physicalOwnership: physical, processAdmission: budget });
    const cold = createMetaRunner({
      launcher: h.launcher, config: metaDefaults,
      transcripts: { load: async () => h.saved.at(-1) ?? null, save: async () => {}, delete: async () => {} },
    });
    const warm = createAcpMetaRunner({ pool, newSessionId: () => 'warm-app', providerId: 'copilot', defaultModel: () => 'auto' });
    const routed = createPooledMetaRunner({
      pools: [{ purpose: 'general', ready: () => pool.idleCount > 0, stats: () => pool.stats(), runDetailed: warm.runDetailed }],
      fallback: cold, defaultTimeoutMs: 1000,
    });
    try {
      await pool.start();
      const running = ownership.own({ operationId: 'fallback', featureId: 'f', automationId: null, originSessionId: null }, async (lease) => {
        lease.expectPhysicalOwnership();
        return routed.runDetailed({ operationId: 'fallback', featureId: 'f', prompt: 'go', providerId: 'copilot', model: 'auto', signal: lease.signal });
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.started).toHaveLength(1);
      if (budget) {
        expect(budget.stats()).toMatchObject({ processes: 2, warmProcesses: 1 });
        const queued = ownership.own({ operationId: 'queued', featureId: 'g', automationId: null, originSessionId: null }, async (lease) => {
          lease.expectPhysicalOwnership();
          return routed.runDetailed({ operationId: 'queued', featureId: 'g', prompt: 'queued fallback', providerId: 'copilot', signal: lease.signal });
        });
        const cancelled = expect(queued).rejects.toMatchObject({ termination: 'not-started' });
        await new Promise((resolve) => setImmediate(resolve));
        expect(budget.stats().queued).toBe(1);
        expect(h.started).toHaveLength(1);
        expect(await ownership.quiesceFeature('g', 100)).toBe(true);
        await cancelled;
        expect(budget.stats().queued).toBe(0);
        expect(h.rs.kills).toBe(0);
      }
      h.rs.emit({ type: 'stdout', line: '{"response":"cold full result"}' });
      h.rs.finish(0);
      expect(await running).toMatchObject({ text: 'cold full result', transport: 'session' });
      expect(await ownership.quiesceFeature('f', 0)).toBe(false);
      if (budget) expect(clients).toHaveLength(1);
      else expect(clients[1].state.kills).toBe(0);
      clients[0].exit();
      expect(await ownership.quiesceFeature('f', 100)).toBe(true);
      expect(clients[1].state.kills).toBe(0);
    } finally { budget?.close(); pool.close(); clients.forEach((client) => client.exit()); }
  });

  const setup = () => {
    const physical = createMetaOperationPhysicalOwnership({ newOwnerId: () => 'cold-attempt' });
    let owner!: MetaOperationPhysicalOwner;
    const registration = {
      newOwnerId: physical.newOwnerId,
      register: (id: string, attempt: MetaOperationPhysicalOwner) => { owner = attempt; physical.register(id, attempt); },
    };
    physical.begin('op'); physical.expect('op');
    return { physical, registration, owner: () => owner };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('registers before bootstrap and retains uncancelled bootstrap IO even after the launch caller rejects', async () => {
    const p = setup();
    let release!: () => void;
    const h = harness({ physicalOwnership: p.registration, readiness: () => new Promise<void>((resolve) => { release = resolve; }) });
    const running = h.launcher.start({ operationId: 'op', featureId: 'f', prompt: 'go' });
    const failure = expect(running).rejects.toThrow('cancelled');
    await flush();
    expect(await p.physical.quiesce('op', 0)).toBe('unconfirmed');
    await failure;
    expect(h.getSpec()).toBeUndefined();
    const sealed = p.physical.seal('op');
    expect(await p.physical.quiesce('op', 0)).toBe('unconfirmed');
    release();
    expect(await sealed).toBe('confirmed');
    expect(await p.owner().quiesce(0)).toBe('not-started');
  });

  it('waits for actual exit and transcript persistence, not a kill request', async () => {
    const p = setup();
    let release!: () => void;
    const h = harness({ physicalOwnership: p.registration, save: () => new Promise<void>((resolve) => { release = resolve; }) });
    const launched = await h.launcher.start({ operationId: 'op', featureId: 'f', prompt: 'go', kind: 'meta' });
    expect(await p.physical.quiesce('op', 0)).toBe('unconfirmed');
    expect(h.rs.kills).toBe(1);
    h.rs.finish(0);
    await flush();
    expect(await p.physical.quiesce('op', 0)).toBe('unconfirmed');
    release(); await launched.completion;
    expect(await p.owner().quiesce(0)).toBe('exited');
    expect(await p.physical.seal('op')).toBe('confirmed');
    expect(h.rs.kills).toBe(1);
  });

  it('preserves unknown native completion until a later real exit event', async () => {
    const p = setup();
    const h = harness({ physicalOwnership: p.registration });
    const launched = await h.launcher.start({ operationId: 'op', featureId: 'f', prompt: 'go', kind: 'meta' });
    const failure = expect(launched.completion).rejects.toThrow('unknown completion');
    h.rs.fail(new Error('unknown completion')); await failure;
    expect(await h.launcher.waitForIdle(0)).toBe(false);
    expect(await p.physical.quiesce('op', 0)).toBe('unconfirmed');
    const sealed = p.physical.seal('op');
    h.rs.emit({ type: 'exit', code: null });
    expect(await sealed).toBe('confirmed');
    expect(await h.launcher.waitForIdle(100)).toBe(true);
  });

  it('rejects unadmitted native attempts before bootstrap or provider IO', async () => {
    const p = setup();
    const h = harness({ physicalOwnership: p.registration });
    await expect(h.launcher.start({ operationId: 'other', featureId: 'f', prompt: 'go' })).rejects.toThrow('not admitted');
    expect(h.bootstrapCalls).toEqual([]); expect(h.getSpec()).toBeUndefined();
    expect(await p.physical.seal('op')).toBe('unknown');
    p.physical.forget('op');
  });
});

describe('session-launcher', () => {
  it('finalizes a started record when a subscriber cancels before provider spawn', async () => {
    const h = harness();
    h.bus.on('session.started', () => h.launcher.shutdown());
    await expect(h.launcher.start({ featureId: 'f1', prompt: 'go' })).rejects.toThrow('cancelled');
    expect(h.started).toHaveLength(1);
    expect(h.ended).toMatchObject([{ status: 'cancelled', exitCode: null }]);
    expect(h.getSpec()).toBeUndefined();
    expect(await h.launcher.waitForIdle(100)).toBe(true);
  });

  it('retains startup and finalization errors if compensating publication also fails', async () => {
    const startupError = new Error('started publication failed');
    const finalError = new Error('final publication failed');
    const h = harness();
    h.bus.on('session.started', () => { throw startupError; });
    h.bus.on('session.ended', () => { throw finalError; });
    await expect(h.launcher.start({ featureId: 'f1', prompt: 'go' }))
      .rejects.toMatchObject({ errors: [startupError, finalError] });
    expect(await h.launcher.waitForIdle(100)).toBe(true);
  });

  it('owns direct runs through confirmed exit and transcript persistence during shutdown', async () => {
    let finishSave!: () => void;
    const h = harness({ save: () => new Promise<void>((resolve) => { finishSave = resolve; }) });
    const launched = await h.launcher.start({ featureId: 'f1', prompt: 'go' });
    h.launcher.shutdown();
    expect(h.rs.kills).toBe(1);
    await expect(h.launcher.start({ featureId: 'f1', prompt: 'late' }))
      .rejects.toMatchObject({ kind: 'conflict' });
    expect(await h.launcher.waitForIdle(1)).toBe(false);
    h.rs.finish(0);
    expect(await h.launcher.waitForIdle(1)).toBe(false);
    expect(h.ended).toEqual([]);
    finishSave();
    await launched.completion;
    expect(await h.launcher.waitForIdle(100)).toBe(true);
    expect(h.ended[0].status).toBe('cancelled');
    h.rs.emit({ type: 'stdout', line: 'late output' });
    expect(h.outputs.some((item) => item.event.type === 'stdout')).toBe(false);
  });

  it('retains ownership of cancelled bootstrap IO after the launch request rejects', async () => {
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const h = harness({
      readiness: () => new Promise<void>((resolve) => { finish = resolve; enter(); }),
    });
    const launching = h.launcher.start({ featureId: 'f1', prompt: 'go' });
    await entered;
    h.launcher.shutdown();
    await expect(launching).rejects.toThrow('cancelled');
    expect(await h.launcher.waitForIdle(1)).toBe(false);
    finish();
    expect(await h.launcher.waitForIdle(100)).toBe(true);
    expect(h.getSpec()).toBeUndefined();
  });

  it('blocks feature admission before cancelling and draining bootstrap work', async () => {
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const h = harness({
      readiness: () => new Promise<void>((resolve) => { finish = resolve; enter(); }),
    });
    const launching = h.launcher.start({ featureId: 'f1', prompt: 'go' });
    await entered;
    const drained = h.launcher.quiesceFeature('f1', 1);
    await expect(launching).rejects.toThrow('cancelled');
    expect(await drained).toBe(false);
    await expect(h.launcher.start({ featureId: 'f1', prompt: 'late' }))
      .rejects.toMatchObject({ kind: 'conflict' });
    finish();
    expect(await h.launcher.quiesceFeature('f1', 100)).toBe(true);
  });

  it('does not cancel an unrelated session when quiescing another identity', async () => {
    const h = harness();
    const launched = await h.launcher.start({ featureId: 'f1', prompt: 'go' });
    expect(await h.launcher.quiesceSession('other', 0)).toBe(true);
    expect(await h.launcher.quiesceFeature('other-feature', 0)).toBe(true);
    expect(h.rs.kills).toBe(0);
    const draining = h.launcher.quiesceSession(launched.session.id, 100);
    expect(h.rs.kills).toBe(1);
    h.rs.finish(0);
    expect(await draining).toBe(true);
    await expect(h.launcher.start({ featureId: 'f1', prompt: 'same factory id' }))
      .rejects.toThrow('cancelled');
  });

  it('reserves queued launch ownership before shutdown can close admission', async () => {
    const h = harness();
    const launching = h.launcher.start({ featureId: 'f1', prompt: 'go' });
    h.launcher.shutdown();
    await expect(launching).rejects.toThrow('cancelled');
    expect(await h.launcher.waitForIdle(100)).toBe(true);
    expect(h.bootstrapCalls).toEqual([]);
  });

  it('records a failed final state when provider startup throws after session.started', async () => {
    const error = new Error('spawn failed');
    const h = harness({ onStartSession: () => { throw error; } });
    await expect(h.launcher.start({ featureId: 'f1', prompt: 'go' })).rejects.toBe(error);
    expect(h.started).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({ status: 'failed', exitCode: null });
    expect(await h.launcher.waitForIdle(100)).toBe(true);
  });

  it('starts a session, streams output and completes on exit 0', async () => {
    const h = harness();
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      model: 'gpt-5.4',
      prompt: 'hello',
    });

    expect(launched.session.status).toBe('running');
    expect(launched.session.startedAt).toBe('2025-01-01T00:00:05.000Z');
    expect(h.started).toHaveLength(1);

    const spec = h.getSpec()!;
    expect(spec.sessionId).toBe('sess-1');
    expect(spec.model).toBe('gpt-5.4');
    expect(spec.otelFilePath).toContain('sess-1.jsonl');
    expect(spec.prompt).toBe('BOOTSTRAP\n\n## User Request\n\nhello');
    expect(launched.session.prompt).toBe('hello');

    h.rs.emit({ type: 'stdout', line: 'hi there' });
    h.rs.finish(0);

    const final = await launched.completion;
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    expect(final.endedAt).toBe('2025-01-01T00:00:05.000Z');
    expect(h.outputs).toEqual([
      {
        sessionId: 'sess-1',
        scope: 'feature',
        event: { type: 'stdout', line: 'hi there' },
      },
      {
        sessionId: 'sess-1',
        scope: 'feature',
        event: { type: 'exit', code: 0 },
      },
    ]);
    expect(h.saved).toEqual([
      { sessionId: 'sess-1', stdout: ['hi there'], stderr: [], exitCode: 0 },
    ]);
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0].status).toBe('completed');
  });

  it('marks the session failed on a non-zero exit', async () => {
    const h = harness();
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
    });
    expect(launched.session.requestedModel).toBe('auto');

    h.rs.finish(1);
    const final = await launched.completion;
    expect(final.status).toBe('failed');
    expect(final.exitCode).toBe(1);
  });

  it('applies the default kind and forwards cwd and attachments', async () => {
    const h = harness();
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
      cwd: '/work',
      attachments: ['C:\\Temp\\aps-a\\p.md'],
    });
    expect(launched.session.kind).toBe('dev');
    expect(h.getSpec()!.cwd).toBe('/work');
    expect(h.getSpec()!.attachments).toEqual(['C:\\Temp\\aps-a\\p.md']);
    h.rs.finish(0);
    await launched.completion;
  });

  it('keeps internal scope on the session lifecycle and output events', async () => {
    const h = harness();
    const launched = await h.launcher.start({
      featureId: 'repository:repo-1',
      prompt: 'analyze',
      kind: 'meta',
      scope: 'internal',
      cwd: 'C:\\work\\repo',
    });
    expect(launched.session.scope).toBe('internal');
    expect(h.started[0].scope).toBe('internal');
    expect(h.getSpec()!.cwd).toBe('C:\\work\\repo');
    expect(h.getSpec()!.prompt).toBe('analyze');

    h.rs.emit({ type: 'stdout', line: 'result' });
    h.rs.finish(0);
    const ended = await launched.completion;
    expect(ended.scope).toBe('internal');
    expect(h.outputs[0].scope).toBe('internal');
  });

  it('fails the session and emits session.ended when the transcript save fails', async () => {
    const h = harness({ failSave: true });
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
    });
    h.rs.finish(0);
    await expect(launched.completion).rejects.toThrow('disk full');
    expect(h.ended).toHaveLength(1);
    expect(h.ended[0]).toMatchObject({
      id: launched.session.id,
      status: 'failed',
      exitCode: 0,
    });
  });

  it('rejects before creating or launching a new dev session when freshness fails', async () => {
    const h = harness({ readinessError: new Error('context stale') });
    await expect(
      h.launcher.start({ featureId: 'feat-1', prompt: 'hello' }),
    ).rejects.toThrow('context stale');
    expect(h.bootstrapCalls).toEqual(['ready:feat-1']);
    expect(h.started).toEqual([]);
    expect(h.getSpec()).toBeUndefined();
  });

  it('rechecks freshness while composing immediately before provider launch', async () => {
    const h = harness({ composeError: new Error('HEAD changed') });
    await expect(
      h.launcher.start({ featureId: 'feat-1', prompt: 'hello' }),
    ).rejects.toThrow('HEAD changed');
    expect(h.bootstrapCalls).toEqual(['ready:feat-1', 'compose:sess-1']);
    expect(h.started).toEqual([]);
    expect(h.getSpec()).toBeUndefined();
  });

  it('does not freshness-gate provider-neutral meta sessions', async () => {
    const h = harness({ readinessError: new Error('unused') });
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'analyze',
      kind: 'meta',
    });
    expect(h.bootstrapCalls).toEqual([]);
    h.rs.finish(0);
    await launched.completion;
  });

  it('rejects before launch when the request signal is already aborted', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.launcher.start({
        featureId: 'feat-1',
        prompt: 'hello',
        signal: controller.signal,
      }),
    ).rejects.toThrow('Session launch cancelled');
    expect(h.started).toEqual([]);
    expect(h.getSpec()).toBeUndefined();
  });

  it('rejects an already-aborted provider-neutral meta session before resolver launch', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.launcher.start({
        featureId: 'feat-1',
        prompt: 'hello',
        kind: 'meta',
        signal: controller.signal,
      }),
    ).rejects.toThrow('Session launch cancelled');
    expect(h.started).toEqual([]);
    expect(h.getSpec()).toBeUndefined();
  });

  it('does not start the provider when cancellation lands during bootstrap', async () => {
    let releaseCompose: () => void = () => undefined;
    let enterCompose!: () => void;
    const composeEntered = new Promise<void>((resolve) => {
      enterCompose = resolve;
    });
    const h = harness({
      compose: async () => {
        enterCompose();
        return new Promise<string>((resolve) => {
          releaseCompose = () => resolve('BOOTSTRAP');
        });
      },
    });
    const controller = new AbortController();
    const starting = h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
      signal: controller.signal,
    });
    await composeEntered;
    controller.abort();
    await expect(starting).rejects.toThrow('Session launch cancelled');
    releaseCompose();
    expect(h.started).toEqual([]);
    expect(h.getSpec()).toBeUndefined();
  });

  it('rethrows bootstrap failures while still detaching the abort listener', async () => {
    const h = harness({
      compose: async () => {
        throw new Error('compose failed');
      },
    });
    const controller = new AbortController();
    await expect(
      h.launcher.start({
        featureId: 'feat-1',
        prompt: 'hello',
        signal: controller.signal,
      }),
    ).rejects.toThrow('compose failed');
  });

  it('kills an already-started session when the launch signal aborts before exit', async () => {
    const h = harness();
    const controller = new AbortController();
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
      signal: controller.signal,
    });
    controller.abort();
    expect(h.rs.kills).toBe(1);
    h.rs.finish(1);
    const ended = await launched.completion;
    expect(ended.status).toBe('cancelled');
  });

  it('ignores duplicate abort notifications for a running session', async () => {
    const listeners = new Set<() => void>();
    const signal = {
      aborted: false,
      addEventListener: (_type: string, handler: () => void) => {
        listeners.add(handler);
      },
      removeEventListener: (_type: string, handler: () => void) => {
        listeners.delete(handler);
      },
      dispatchTwice: () => {
        for (const handler of [...listeners]) {
          handler();
        }
        for (const handler of [...listeners]) {
          handler();
        }
      },
    } as unknown as AbortSignal & { dispatchTwice: () => void };
    const h = harness();
    await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
      signal,
    });
    signal.dispatchTwice();
    expect(h.rs.kills).toBe(1);
  });

  it('kills immediately when the launch signal flips to aborted during provider start', async () => {
    const controller = new AbortController();
    const h = harness({
      onStartSession: () => {
        controller.abort();
      },
    });
    await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
      signal: controller.signal,
    });
    expect(h.rs.kills).toBe(1);
  });

  it('ignores provider kill errors while aborting a running session', async () => {
    const h = harness({
      kill: () => {
        throw new Error('kill failed');
      },
    });
    const controller = new AbortController();
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
      signal: controller.signal,
    });
    controller.abort();
    expect(h.rs.kills).toBe(1);
    h.rs.finish(1);
    await expect(launched.completion).resolves.toMatchObject({
      status: 'cancelled',
    });
  });
});
