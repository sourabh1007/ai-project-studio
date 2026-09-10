import { describe, it, expect, vi } from 'vitest';
import { createTerminalManager } from './terminal-manager.js';
import { terminalDefaults } from './config.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import type { IAIProvider } from '../provider/provider-contract.js';
import type { SessionEventMap } from '../session/session-launcher.js';
import type { Session } from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';
import type { PtyProcess, PtySpawnRequest, PtySpawner } from './pty-contract.js';
import { ConflictError } from '../kernel/error-types.js';

function fakePtyEnv() {
  const requests: PtySpawnRequest[] = [];
  const writes: string[] = [];
  let dataCb: (d: string) => void = () => {};
  let exitCb: (c: number | null) => void = () => {};
  let kills = 0;
  let writeError: Error | undefined;
  let spawnError: Error | undefined;
  let dataOnExitRegistration: string | undefined;
  const pty: PtyProcess = {
    write: (d) => {
      if (writeError) {
        throw writeError;
      }
      writes.push(d);
    },
    resize: () => {},
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
      if (dataOnExitRegistration !== undefined) {
        dataCb(dataOnExitRegistration);
      }
    },
    kill: () => {
      kills += 1;
    },
  };
  const spawner: PtySpawner = {
    spawn: (req) => {
      if (spawnError) {
        throw spawnError;
      }
      requests.push(req);
      return pty;
    },
  };
  return {
    spawner,
    requests,
    writes,
    emitData: (d: string) => dataCb(d),
    emitExit: (c: number | null) => exitCb(c),
    captureExit: () => exitCb,
    kills: () => kills,
    failWrites: (error?: Error) => {
      writeError = error;
    },
    failSpawns: (error?: Error) => {
      spawnError = error;
    },
    emitWhenExitHandlerRegisters: (data: string) => {
      dataOnExitRegistration = data;
    },
  };
}

function interactiveProvider(
  withScanner = false,
  withModelScanner = false,
  withMcpScanner = false,
): IAIProvider {
  const provider: IAIProvider = {
    id: 'copilot',
    listModels: async () => [],
    startSession: () => {
      throw new Error('unused');
    },
    buildInteractiveCommand: (spec) => ({
      command: 'copilot',
      args: ['--model', spec.model, '--session-id', spec.sessionId],
      env: { OTEL: spec.otelFilePath },
    }),
  };
  if (withScanner) {
    // A trivial scanner: each fed chunk names one created file for assertions.
    provider.createOutputScanner = (ctx) => ({
      feed: (chunk) =>
        chunk.startsWith('FILE:')
          ? [{ path: `${ctx.home}/${chunk.slice(5).trim()}`, tool: 'create' }]
          : [],
    });
  }
  if (withModelScanner) {
    // A trivial scanner: a `MODEL:` chunk names one newly-selected model.
    provider.createModelChangeScanner = () => ({
      feed: (chunk) =>
        chunk.startsWith('MODEL:') ? [chunk.slice(6).trim()] : [],
    });
  }
  if (withMcpScanner) {
    // A trivial scanner: an `MCPFAIL:` chunk names one failing MCP server (with
    // a reason); an `MCPBARE:` chunk names one with no reason.
    provider.createMcpErrorScanner = () => ({
      feed: (chunk) => {
        if (chunk.startsWith('MCPFAIL:')) {
          return [{ server: chunk.slice(8).trim(), reason: 'boom' }];
        }
        if (chunk.startsWith('MCPBARE:')) {
          return [{ server: chunk.slice(8).trim(), reason: '' }];
        }
        return [];
      },
    });
  }
  return provider;
}

function fakeTranscriptStore() {
  const saved: Transcript[] = [];
  return {
    store: {
      save: async (t: Transcript) => {
        saved.push(t);
      },
      load: async () => null,
      delete: async () => undefined,
    },
    saved,
  };
}

function sampleSession(): Session {
  return {
    id: 'sess-1',
    featureId: 'feat-1',
    name: null,
    provider: 'copilot',
    requestedModel: 'gpt-5.4',
    resolvedModel: null,
    status: 'created',
    kind: 'dev',
    prompt: '',
    usageFilePath: '/tmp/sess-1.jsonl',
    createdAt: '2020-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
}

function makeManager(
  instructions = '',
  withScanner = false,
  bootstrapError?: Error,
  modelOpts: {
    withModelScanner?: boolean;
    trackModel?: boolean;
    withMcpScanner?: boolean;
  } = {},
  isTransientFailure?: (line: string) => boolean,
  extra: {
    selfRecovery?: {
      enabled: boolean;
      useMetaAnalysis: boolean;
      analyze?: (errorText: string) => Promise<string | null>;
      report: (sessionId: string, message: string) => void;
    };
    configOverride?: Partial<typeof terminalDefaults>;
    composeFailOnCall?: number;
    compose?: (call: number) => Promise<string>;
    save?: (transcript: Transcript) => Promise<void>;
    spawner?: PtySpawner;
  } = {},
) {
  const env = fakePtyEnv();
  const bus = createEventBus<SessionEventMap>();
  const providers = createProviderRegistry();
  providers.register(
    interactiveProvider(
      withScanner,
      modelOpts.withModelScanner ?? false,
      modelOpts.withMcpScanner ?? false,
    ),
  );
  const ts = fakeTranscriptStore();
  const started: Session[] = [];
  const ended: Session[] = [];
  const discarded: string[] = [];
  const fileEvents: Array<{ sessionId: string }> = [];
  const notices: Array<{ sessionId: string; level: string; message: string }> =
    [];
  bus.on('session.started', (s) => started.push(s));
  bus.on('session.ended', (s) => ended.push(s));
  bus.on('session.discarded', (id) => discarded.push(id));
  bus.on('session.file', (e) => fileEvents.push(e));
  bus.on('session.notice', (n) => notices.push(n));
  const instructionCalls: string[] = [];
  const recorded: Array<{ sessionId: string; path: string; tool: string }> = [];
  const modelResolved: Array<{ sessionId: string; model: string }> = [];
  const logger = { error: vi.fn() };
  const manager = createTerminalManager({
    logger,
    spawner: extra.spawner ?? env.spawner,
    providers,
    bus,
    clock: createClock(() => 0),
    config: extra.configOverride
      ? { ...terminalDefaults, ...extra.configOverride }
      : terminalDefaults,
    transcriptStore: { ...ts.store, save: extra.save ?? ts.store.save },
    bootstrap: {
      composeForSession: async (session) => {
        instructionCalls.push(session.id);
        if (bootstrapError) {
          throw bootstrapError;
        }
        if (
          extra.composeFailOnCall !== undefined &&
          instructionCalls.length === extra.composeFailOnCall
        ) {
          throw new Error('compose failed on restart');
        }
        return extra.compose ? extra.compose(instructionCalls.length) : instructions;
      },
    },
    sessionFiles: {
      record: (sessionId, path, tool) => {
        recorded.push({ sessionId, path, tool });
      },
    },
    onModelResolved:
      modelOpts.trackModel === false
        ? undefined
        : (sessionId, model) => {
            modelResolved.push({ sessionId, model });
          },
    isTransientFailure,
    selfRecovery: extra.selfRecovery,
    home: '/home/me',
  });
  return {
    bus,
    manager,
    env,
    started,
    ended,
    discarded,
    fileEvents,
    notices,
    saved: ts.saved,
    instructionCalls,
    recorded,
    modelResolved,
    logger,
  };
}

describe('createTerminalManager', () => {
  it('finalizes a started record when native PTY spawn fails', async () => {
    const h = makeManager();
    const error = new Error('ENOENT');
    h.env.failSpawns(error);
    await expect(h.manager.getOrLaunch(sampleSession())).rejects.toBe(error);
    expect(h.started).toHaveLength(1);
    expect(h.ended).toMatchObject([{ status: 'failed', exitCode: null }]);
    expect(await h.manager.waitForIdle(100)).toBe(true);
  });

  it.each(['shutdown', 'close', 'feature'] as const)(
    'finalizes cancellation by a started subscriber before PTY spawn: %s',
    async (action) => {
      const h = makeManager();
      h.bus.on('session.started', (session) => {
        if (action === 'shutdown') h.manager.shutdown();
        else if (action === 'close') h.manager.close(session.id);
        else void h.manager.quiesceFeature(session.featureId, 100);
      });
      await expect(h.manager.getOrLaunch(sampleSession())).rejects.toThrow('cancelled');
      expect(h.env.requests).toEqual([]);
      expect(h.ended).toMatchObject([{ status: 'cancelled', exitCode: null }]);
      expect(await h.manager.waitForIdle(100)).toBe(true);
    },
  );

  it('retains startup and finalization errors when both publications fail', async () => {
    const h = makeManager();
    const startupError = new Error('started publication failed');
    const finalError = new Error('final publication failed');
    h.bus.on('session.started', () => { throw startupError; });
    h.bus.on('session.ended', () => { throw finalError; });
    await expect(h.manager.getOrLaunch(sampleSession()))
      .rejects.toMatchObject({ errors: [startupError, finalError] });
    expect(await h.manager.waitForIdle(100)).toBe(true);
  });

  it.each(['shutdown', 'feature'] as const)(
    'attempts every PTY termination even when the first kill throws: %s',
    async (action) => {
      const kills: number[] = [];
      const exits: Array<(code: number | null) => void> = [];
      const spawner: PtySpawner = {
        spawn: () => {
          const index = kills.length;
          kills.push(0);
          return {
            write: () => {}, resize: () => {}, onData: () => {},
            onExit: (callback) => { exits[index] = callback; },
            kill: () => {
              kills[index]++;
              if (index === 0) throw new Error('kill failed');
            },
          };
        },
      };
      const h = makeManager('', false, undefined, {}, undefined, { spawner });
      await h.manager.getOrLaunch(sampleSession());
      await h.manager.getOrLaunch({ ...sampleSession(), id: 'sess-2' });
      for (let attempt = 0; attempt < 2; attempt++) {
        if (action === 'shutdown') expect(() => h.manager.shutdown()).toThrow(AggregateError);
        else await expect(h.manager.quiesceFeature('feat-1', 100)).rejects.toThrow(AggregateError);
      }
      expect(kills).toEqual([2, 2]);
      expect(await h.manager.waitForIdle(1)).toBe(false);
      exits[0](1);
      exits[1](0);
      expect(await h.manager.waitForIdle(100)).toBe(true);
    },
  );

  it('still requests native termination when a lifecycle notification listener throws', async () => {
    const h = makeManager();
    await h.manager.getOrLaunch(sampleSession());
    h.manager.onTerminal('sess-1', () => { throw new Error('notification failed'); });
    expect(() => h.manager.close('sess-1')).toThrow(AggregateError);
    expect(h.env.kills()).toBe(1);
    h.env.emitExit(0);
    expect(await h.manager.waitForIdle(100)).toBe(true);
  });

  it('does not claim an instruction was injected while a killed PTY awaits native exit', async () => {
    const h = makeManager();
    await h.manager.getOrLaunch(sampleSession());
    h.manager.close('sess-1');
    expect(h.manager.injectInstructions('sess-1', 'NOT SENT')).toBe(false);
    expect(h.env.writes).toEqual([]);
    h.env.emitExit(0);
  });
  it('reserves the launch before synchronous internal-session lifecycle callbacks can reenter', async () => {
    const env = fakePtyEnv();
    const providers = createProviderRegistry();
    providers.register(interactiveProvider());
    const bus = createEventBus<SessionEventMap>();
    const manager = createTerminalManager({
      logger: { error: vi.fn() },
      spawner: env.spawner, providers, bus, clock: createClock(() => 0), config: terminalDefaults,
      transcriptStore: fakeTranscriptStore().store, bootstrap: { composeForSession: async () => '' },
      sessionFiles: { record: () => {} }, home: 'fixture',
    });
    let reentered!: Promise<import('./terminal-session.js').TerminalSession>;
    bus.on('session.started', (session) => { reentered = manager.getOrLaunch(session); });
    const first = await manager.getOrLaunch({ ...sampleSession(), kind: 'meta' });
    expect(await reentered).toBe(first);
    expect(env.requests).toHaveLength(1);
  });
  it('old exit cannot remove a replacement installed by an exit listener', async () => {
    const h = makeManager();
    const session = { ...sampleSession(), kind: 'meta' as const };
    const old = await h.manager.getOrLaunch(session);
    let replacement!: Promise<import('./terminal-session.js').TerminalSession>;
    old.attach({
      send: () => {},
      exit: () => { replacement = h.manager.getOrLaunch(session); },
    });
    h.env.emitExit(1);
    const current = await replacement;
    expect(current).not.toBe(old);
    expect(h.manager.get(session.id)).toBe(current);
    expect(h.env.requests).toHaveLength(2);
    expect(h.ended).toMatchObject([{ id: session.id, status: 'failed' }]);
  });
  it('launches the interactive CLI in a PTY and emits session.started', async () => {
    const { manager, env, started } = makeManager();
    const terminal = await manager.getOrLaunch(sampleSession(), {
      cols: 100,
      rows: 40,
      cwd: '/work',
    });
    expect(terminal.sessionId).toBe('sess-1');
    expect(env.requests).toHaveLength(1);
    const req = env.requests[0];
    expect(req.command).toBe('copilot');
    expect(req.args).toEqual(['--model', 'gpt-5.4', '--session-id', 'sess-1']);
    expect(req.env.OTEL).toBe('/tmp/sess-1.jsonl');
    expect(req.cols).toBe(100);
    expect(req.rows).toBe(40);
    expect(req.cwd).toBe('/work');
    expect(started).toHaveLength(1);
    expect(started[0].status).toBe('running');
  });

  it('auto-retries only a provider-confirmed replay-safe request', async () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager(
        '',
        false,
        undefined,
        {},
        (line) => line.includes('503'),
        { configOverride: { autoRetryEnabled: true } },
      );
      await manager.getOrLaunch(sampleSession());
      manager.observeInput('sess-1', 'fix it\r');
      manager.confirmReplaySafeRequest('sess-1', 'fix it');
      env.emitData('Execution failed: 503 Service Unavailable\n');
      vi.advanceTimersByTime(terminalDefaults.autoRetryBackoffMs);
      expect(env.writes).toContain('fix it');
      env.emitExit(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows manual retry guidance instead of replaying raw terminal input', async () => {
    const { manager, env } = makeManager(
      '',
      false,
      undefined,
      {},
      (line) => line.includes('503'),
      { configOverride: { autoRetryEnabled: true } },
    );
    const terminal = await manager.getOrLaunch(sampleSession());
    const output: string[] = [];
    terminal.attach({ send: (data) => output.push(data), exit: () => {} });
    manager.observeInput('sess-1', 'fix it\r');
    env.emitData('Execution failed: 503 Service Unavailable\n');
    expect(env.writes).not.toContain('fix it');
    expect(output.join('')).toContain('retry manually if needed');
  });
  it('does not send a delayed retry Enter after Ctrl-C or new user input', async () => {
    vi.useFakeTimers();
    try {
      for (const input of ['\x03', 'new prompt']) {
        const { manager, env } = makeManager('', false, undefined, {}, (line) => line.includes('503'),
          { configOverride: { autoRetryEnabled: true } });
        await manager.getOrLaunch(sampleSession());
        manager.confirmReplaySafeRequest('sess-1', 'fix it');
        env.emitData('503\n');
        vi.advanceTimersByTime(terminalDefaults.autoRetryBackoffMs);
        expect(env.writes).toEqual(['fix it']);
        manager.observeInput('sess-1', input);
        vi.runAllTimers();
        expect(env.writes).toEqual(['fix it']);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['before-ready', 'after-paste'] as const)('cancels recovery seeding %s without leaving input blocked', async (stage) => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('bootstrap');
      const terminal = await manager.getOrLaunch(sampleSession(), { replaySeed: 'confirmed replay' });
      if (stage === 'after-paste') {
        vi.advanceTimersByTime(terminalDefaults.instructionSeedReadyTimeoutMs);
        expect(env.writes).toEqual(['bootstrap']);
      }
      manager.observeInput('sess-1', '\x03');
      vi.runAllTimers();
      expect(env.writes).toEqual(stage === 'after-paste' ? ['bootstrap'] : []);
      expect(terminal.inputReadiness).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['exit', 'close', 'shutdown'] as const)(
    'cancels a pending confirmed retry on %s',
    async (action) => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager(
          '',
          false,
          undefined,
          {},
          (line) => line.includes('503'),
          { configOverride: { autoRetryEnabled: true } },
        );
        await manager.getOrLaunch(sampleSession());
        manager.confirmReplaySafeRequest('sess-1', 'fix it');
        env.emitData('Execution failed: 503 Service Unavailable\n');
        if (action === 'exit') {
          env.emitExit(0);
        } else if (action === 'close') {
          manager.close('sess-1');
        } else {
          manager.shutdown();
        }
        vi.advanceTimersByTime(terminalDefaults.autoRetryBackoffMs);
        expect(env.writes).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not auto-retry when no transient classifier is provided', async () => {
    const { manager, env } = makeManager();
    await manager.getOrLaunch(sampleSession());
    manager.observeInput('sess-1', 'fix it\r');
    env.emitData('Execution failed: 503 Service Unavailable\n');
    expect(env.writes).not.toContain('fix it');
  });

  describe('self-recovery escalation', () => {
    const flush = async (times = 8): Promise<void> => {
      for (let i = 0; i < times; i += 1) {
        await Promise.resolve();
      }
    };

    function makeSelfRecovering(
      opts: {
        analyze?: (errorText: string) => Promise<string | null>;
        composeFailOnCall?: number;
        instructions?: string;
        compose?: (call: number) => Promise<string>;
      } = {},
    ) {
      const report = vi.fn<(sessionId: string, message: string) => void>();
      const h = makeManager(
        opts.instructions ?? '',
        false,
        undefined,
        {},
        (line) => line.includes('400'),
        {
          selfRecovery: {
            enabled: true,
            useMetaAnalysis: opts.analyze !== undefined,
            analyze: opts.analyze,
            report,
          },
          // Skip the non-destructive re-submits so the first 400 escalates.
          configOverride: { autoRetryEnabled: false },
          composeFailOnCall: opts.composeFailOnCall,
          compose: opts.compose,
        },
      );
      return { ...h, report };
    }

    it.each(['input', 'pending'] as const)(
      'does not replay recovery bootstrap invalidated by newer %s',
      async (newer) => {
        let finishRecovery!: (value: string) => void;
        let finishNew!: (value: string) => void;
        const recovery = new Promise<string>((resolve) => { finishRecovery = resolve; });
        const nextBootstrap = new Promise<string>((resolve) => { finishNew = resolve; });
        const h = makeSelfRecovering({
          compose: (call) => call === 2 ? recovery : call === 3 ? nextBootstrap : Promise.resolve(''),
        });
        const notifications = vi.fn();
        await h.manager.getOrLaunch(sampleSession());
        h.manager.onTerminal('sess-1', notifications);
        h.manager.confirmReplaySafeRequest('sess-1', 'old prompt');
        h.env.emitData('Error: 400 Bad Request\n');
        await flush();
        h.env.emitExit(0);
        await flush();
        expect(h.instructionCalls).toHaveLength(2);
        let replacement: ReturnType<typeof h.manager.getOrLaunch> | undefined;
        if (newer === 'input') h.manager.observeInput('sess-1', 'new prompt\r');
        else {
          replacement = h.manager.getOrLaunch(sampleSession());
          await flush();
          expect(h.instructionCalls).toHaveLength(3);
        }
        notifications.mockClear();
        finishRecovery('');
        await flush(20);
        expect(h.env.requests).toHaveLength(1);
        if (newer === 'input') expect(notifications).toHaveBeenCalledWith(null, true);
        else {
          expect(notifications).not.toHaveBeenCalled();
          finishNew('');
          await replacement;
          expect(h.env.requests).toHaveLength(2);
          h.manager.close('sess-1');
          h.env.emitExit(0);
        }
        expect(await h.manager.waitForIdle(100)).toBe(true);
        expect(h.report).not.toHaveBeenCalled();
      },
    );

    it('logs a rejected recovery callback and releases its owned work', async () => {
      const h = makeSelfRecovering({ composeFailOnCall: 2 });
      const failure = new Error('recovery report failed');
      h.report.mockImplementation(() => { throw failure; });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.confirmReplaySafeRequest('sess-1', 'old prompt');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      h.env.emitExit(0);
      expect(await h.manager.waitForIdle(100)).toBe(true);
      await flush();
      expect(h.logger.error).toHaveBeenCalledWith('Terminal recovery failed', {
        sessionId: 'sess-1', error: failure,
      });
    });

    it('restarts the CLI and replays the prompt once re-submits are spent', async () => {
      const analyze = vi
        .fn<(text: string) => Promise<string | null>>()
        .mockResolvedValue('History too large; a restart clears it.');
      const h = makeSelfRecovering({ analyze });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');

      // The CLI rejects the corrupted conversation; escalation kicks off.
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      // The escalation is now awaiting the old PTY's exit; release it.
      h.env.emitExit(0);
      await flush();

      expect(analyze).toHaveBeenCalledWith('Error: 400 Bad Request');
      // A fresh CLI was spawned (relaunch) and the old one discarded, not ended.
      expect(h.env.requests).toHaveLength(2);
      expect(h.started).toHaveLength(2);
      expect(h.discarded).toEqual(['sess-1']);
      expect(h.ended).toHaveLength(0);
      expect(h.report).not.toHaveBeenCalled();
    });

    it('handles an exit during replacement notification and shares the recovery launch', async () => {
      const h = makeSelfRecovering();
      await h.manager.getOrLaunch(sampleSession());
      h.manager.onTerminal('sess-1', (terminal) => {
        if (terminal === null) h.env.emitExit(0);
      });
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      expect(h.env.requests).toHaveLength(2);
      expect(h.env.kills()).toBe(0);
    });

    it('replays the last prompt after the relaunched CLI is ready', async () => {
      vi.useFakeTimers();
      try {
        const h = makeSelfRecovering();
        await h.manager.getOrLaunch(sampleSession());
        h.manager.observeInput('sess-1', 'try again\r');
        h.manager.confirmReplaySafeRequest('sess-1', 'try again');
        h.env.emitData('Error: 400 Bad Request\n');
        await flush();
        h.env.emitExit(0);
        await flush();

        // The relaunched terminal seeds the replayed prompt on its ready marker.
        h.env.emitData('type / for commands');
        expect(h.env.writes).toContain('try again');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        expect(h.manager.get('sess-1')?.inputReadiness).toBe('ready');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not restart after analysis once new user input supersedes the confirmed request', async () => {
      let resolve!: (value: string) => void;
      const analysis = new Promise<string>((yes) => {
        resolve = yes;
      });
      const h = makeSelfRecovering({ analyze: () => analysis });
      const terminal = await h.manager.getOrLaunch(sampleSession());
      const output: string[] = [];
      terminal.attach({ send: (data) => output.push(data), exit: () => {} });
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      h.manager.observeInput('sess-1', 'n');
      resolve('analysis complete');
      await flush();
      expect(h.env.requests).toHaveLength(1);
      expect(h.report).not.toHaveBeenCalled();
      expect(output.join('')).not.toContain('restarting the CLI');
    });

    it('does not restart after injected instructions supersede the confirmed request', async () => {
      let resolve!: (value: string) => void;
      const analysis = new Promise<string>((yes) => {
        resolve = yes;
      });
      const h = makeSelfRecovering({ analyze: () => analysis });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      expect(h.manager.injectInstructions('sess-1', 'Apply this.')).toBe(true);
      resolve('analysis complete');
      await flush();
      expect(h.env.requests).toHaveLength(1);
      expect(h.report).not.toHaveBeenCalled();
    });

    it('does not relaunch an obsolete recovery after new input arrives while awaiting source exit', async () => {
      const h = makeSelfRecovering();
      const published: Array<{ terminal: 'live' | 'reconnecting'; failed?: boolean }> = [];
      await h.manager.getOrLaunch(sampleSession());
      h.manager.onTerminal('sess-1', (terminal, failed) =>
        published.push({
          terminal: terminal ? 'live' : 'reconnecting',
          failed,
        }),
      );
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      expect(h.env.kills()).toBe(1);
      h.manager.observeInput('sess-1', 'new prompt\r');
      h.env.emitExit(0);
      await flush();
      await h.manager.getOrLaunch(sampleSession());
      expect(h.env.requests).toHaveLength(2);
      expect(h.report).not.toHaveBeenCalled();
      expect(published).toEqual([
        { terminal: 'reconnecting', failed: undefined },
        { terminal: 'reconnecting', failed: true },
        { terminal: 'live', failed: undefined },
      ]);
    });

    it('shows manual guidance instead of escalating when no replay-safe request was confirmed', async () => {
      const h = makeSelfRecovering();
      const terminal = await h.manager.getOrLaunch(sampleSession());
      const output: string[] = [];
      terminal.attach({ send: (data) => output.push(data), exit: () => {} });
      h.manager.observeInput('sess-1', 'do it\r');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      expect(h.env.requests).toHaveLength(1);
      expect(h.report).not.toHaveBeenCalled();
      expect(output.join('')).toContain('retry manually if needed');
    });

    it('reports to the status bar when the restart cannot be carried out', async () => {
      // Fail the second compose (the relaunch) so restartSession returns false.
      const h = makeSelfRecovering({ composeFailOnCall: 2 });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      h.env.emitExit(0);
      await flush();

      expect(h.report).toHaveBeenCalledWith(
        'sess-1',
        'Automatic recovery failed. Restart the session to continue.',
      );
      // Only the original spawn happened; the relaunch threw.
      expect(h.env.requests).toHaveLength(1);
    });

    it('reports to the status bar when the replacement spawn fails after pending was reserved', async () => {
      const h = makeSelfRecovering();
      await h.manager.getOrLaunch(sampleSession());
      h.env.failSpawns(new Error('spawn failed'));
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      h.env.emitExit(0);
      await flush();

      expect(h.report).toHaveBeenCalledWith(
        'sess-1',
        'Automatic recovery failed. Restart the session to continue.',
      );
      expect(h.env.requests).toHaveLength(1);
    });

    it('notes analysis was unavailable when the metasession cannot start and restart fails', async () => {
      const analyze = vi
        .fn<(text: string) => Promise<string | null>>()
        .mockRejectedValue(new Error('meta down'));
      const h = makeSelfRecovering({ analyze, composeFailOnCall: 2 });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      h.env.emitExit(0);
      await flush();

      expect(h.report).toHaveBeenCalledWith(
        'sess-1',
        'Automatic recovery failed and the analysis session could not start. Restart the session to continue.',
      );
    });

    it('skips the kill when the session already exited before escalation restarts it', async () => {
      const analyze = vi
        .fn<(text: string) => Promise<string | null>>()
        .mockResolvedValue('diagnosis');
      const h = makeSelfRecovering({ analyze, composeFailOnCall: 2 });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      // Escalation begins and suspends on the analysis; while it is pending the
      // PTY exits on its own, so by the time the restart runs there is no live
      // terminal to kill and it goes straight to (a failing) relaunch.
      h.env.emitData('Error: 400 Bad Request\n');
      h.env.emitExit(0);
      await flush();

      expect(h.report).toHaveBeenCalledWith(
        'sess-1',
        'Automatic recovery failed. Restart the session to continue.',
      );
      // The exit was a normal end (never marked discarded by a restart kill).
      expect(h.ended).toHaveLength(1);
      expect(h.instructionCalls).toHaveLength(2);
    });

    it('recovers after natural exit during analysis with original geometry and ordered bootstrap/replay', async () => {
      vi.useFakeTimers();
      try {
        let resolve!: (value: string) => void;
        const analysis = new Promise<string>((yes) => { resolve = yes; });
        const h = makeSelfRecovering({ analyze: () => analysis, instructions: 'BOOTSTRAP' });
        await h.manager.getOrLaunch(sampleSession(), { cwd: 'original-cwd', cols: 132, rows: 43 });
        h.env.emitData('? help');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        h.manager.observeInput('sess-1', 'do it\r');
        h.manager.confirmReplaySafeRequest('sess-1', 'do it');
        h.env.emitData('Error: 400 Bad Request\n');
        h.env.emitExit(0);
        expect(h.manager.get('sess-1')).toBeUndefined();
        resolve('analysis complete');
        await flush();
        expect(h.env.requests).toHaveLength(2);
        expect(h.env.requests[1]).toMatchObject({ cwd: 'original-cwd', cols: 132, rows: 43 });
        expect(h.env.kills()).toBe(0);
        h.env.emitData('? help');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs * 2);
        expect(h.env.writes).toEqual(['BOOTSTRAP', '\r', 'BOOTSTRAP', '\r', 'do it', '\r']);
        expect(h.manager.get('sess-1')?.inputReadiness).toBe('ready');
        expect(h.ended).toHaveLength(1);
        expect(h.started).toHaveLength(2);
        expect(h.report).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not let an obsolete recovery publish over a newer launch while restart bootstrap is pending', async () => {
      let resolveRecoveryCompose!: (value: string) => void;
      const recoveryCompose = new Promise<string>((yes) => {
        resolveRecoveryCompose = yes;
      });
      const h = makeSelfRecovering({
        compose: (call) => (call === 2 ? recoveryCompose : Promise.resolve('')),
      });
      const published: Array<{ terminal: 'live' | 'reconnecting'; failed?: boolean }> = [];
      await h.manager.getOrLaunch(sampleSession());
      h.manager.onTerminal('sess-1', (terminal, failed) =>
        published.push({
          terminal: terminal ? 'live' : 'reconnecting',
          failed,
        }),
      );
      h.manager.observeInput('sess-1', 'old prompt\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'old prompt');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      expect(h.env.kills()).toBe(1);
      h.env.emitExit(0);
      await flush();
      await h.manager.getOrLaunch(sampleSession());
      expect(h.env.requests).toHaveLength(2);
      resolveRecoveryCompose('');
      await flush();
      expect(h.env.requests).toHaveLength(2);
      expect(h.report).not.toHaveBeenCalled();
      expect(published).toEqual([
        { terminal: 'reconnecting', failed: undefined },
        { terminal: 'live', failed: undefined },
      ]);
    });

    it.each(['live', 'exited', 'pending', 'failed'] as const)(
      'does not replay old recovery over a newer %s launch',
      async (newer) => {
        let resolveAnalysis!: (value: string) => void;
        const analysis = new Promise<string>((yes) => { resolveAnalysis = yes; });
        let resolveCompose!: (value: string) => void;
        const composition = new Promise<string>((yes) => { resolveCompose = yes; });
        const h = makeSelfRecovering({
          analyze: () => analysis,
          composeFailOnCall: newer === 'failed' ? 2 : undefined,
          compose: (call) => call === 2 && newer === 'pending' ? composition : Promise.resolve(''),
        });
        await h.manager.getOrLaunch(sampleSession());
        h.manager.observeInput('sess-1', 'old prompt\r');
        h.manager.confirmReplaySafeRequest('sess-1', 'old prompt');
        h.env.emitData('Error: 400 Bad Request\n');
        h.env.emitExit(0);
        const next = h.manager.getOrLaunch(sampleSession());
        if (newer === 'failed') await expect(next).rejects.toThrow('compose failed');
        else if (newer !== 'pending') await next;
        if (newer === 'exited') h.env.emitExit(0);
        resolveAnalysis('old analysis');
        await flush();
        expect(h.instructionCalls).toHaveLength(2);
        if (newer === 'pending') { resolveCompose(''); await next; }
        expect(h.env.requests).toHaveLength(newer === 'failed' ? 1 : 2);
        expect(h.env.writes).toEqual([]);
        expect(h.env.kills()).toBe(0);
      },
    );

    it.each(['close', 'shutdown'] as const)(
      'cannot resurrect a naturally-exited source after %s during analysis',
      async (action) => {
        let resolve!: (value: string) => void;
        const analysis = new Promise<string>((yes) => { resolve = yes; });
        const h = makeSelfRecovering({ analyze: () => analysis });
        await h.manager.getOrLaunch(sampleSession());
        h.manager.observeInput('sess-1', 'old prompt\r');
        h.manager.confirmReplaySafeRequest('sess-1', 'old prompt');
        h.env.emitData('Error: 400 Bad Request\n');
        h.env.emitExit(0);
        if (action === 'close') h.manager.close('sess-1');
        else h.manager.shutdown();
        resolve('analysis complete');
        await flush();
        expect(h.instructionCalls).toHaveLength(1);
        expect(h.env.requests).toHaveLength(1);
        expect(h.manager.get('sess-1')).toBeUndefined();
      },
    );

    it('re-seeds bootstrap context then replays the prompt on restart', async () => {
      vi.useFakeTimers();
      try {
        const h = makeSelfRecovering({ instructions: 'Follow the rules.' });
        await h.manager.getOrLaunch(sampleSession());
        // Clear the launch-time bootstrap seeding on the first terminal.
        h.env.emitData('type / for commands');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        h.manager.observeInput('sess-1', 'try again\r');
        h.manager.confirmReplaySafeRequest('sess-1', 'try again');

        h.env.emitData('Error: 400 Bad Request\n');
        await flush();
        h.env.emitExit(0);
        await flush();

        // The relaunched terminal seeds bootstrap first, then the replay prompt.
        h.env.emitData('type / for commands');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        expect(h.env.writes).toContain('Follow the rules.');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        expect(h.env.writes).toContain('try again');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        expect(h.manager.get('sess-1')?.inputReadiness).toBe('ready');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not escalate when self-recovery is disabled', async () => {
      const report = vi.fn<(sessionId: string, message: string) => void>();
      const h = makeManager('', false, undefined, {}, (line) =>
        line.includes('400'),
        {
          selfRecovery: {
            enabled: false,
            useMetaAnalysis: true,
            report,
          },
          configOverride: { autoRetryEnabled: false },
        },
      );
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
      h.manager.confirmReplaySafeRequest('sess-1', 'do it');
      h.env.emitData('Error: 400 Bad Request\n');
      await flush();
      expect(report).not.toHaveBeenCalled();
      expect(h.env.requests).toHaveLength(1);
    });
  });

  it('falls back to default terminal size when unspecified', async () => {
    const { manager, env } = makeManager();
    await manager.getOrLaunch(sampleSession());
    expect(env.requests[0].cols).toBe(terminalDefaults.defaultCols);
    expect(env.requests[0].rows).toBe(terminalDefaults.defaultRows);
  });

  it('reuses the running terminal instead of relaunching', async () => {
    const { manager, env } = makeManager();
    const first = await manager.getOrLaunch(sampleSession());
    const second = await manager.getOrLaunch(sampleSession());
    expect(second).toBe(first);
    expect(env.requests).toHaveLength(1);
  });

  it('rejects launch before lifecycle events or spawning when context is not ready', async () => {
    const h = makeManager(
      '',
      false,
      new ConflictError('Repository context is stale'),
    );
    await expect(h.manager.getOrLaunch(sampleSession())).rejects.toEqual(
      expect.objectContaining({ kind: 'conflict' }),
    );
    expect(h.env.requests).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it('shutdown waits for exit and preserves the final transcript instead of discarding it', async () => {
    const { manager, env, ended, discarded } = makeManager();
    await manager.getOrLaunch(sampleSession());
    manager.shutdown();
    expect(env.kills()).toBe(1);
    expect(await manager.waitForIdle(1)).toBe(false);
    env.emitExit(0);
    expect(await manager.waitForIdle(100)).toBe(true);
    expect(ended).toMatchObject([{ status: 'cancelled' }]);
    expect(discarded).toEqual([]);
  });

  it('refuses new launches after shutdown', async () => {
    const h = makeManager();
    await h.manager.getOrLaunch(sampleSession());
    h.manager.shutdown();
    await expect(h.manager.getOrLaunch(sampleSession())).rejects.toThrow(
      'Terminal launch cancelled',
    );
  });

  it('notifies every terminal subscriber on shutdown even after an earlier callback fails', async () => {
    const h = makeManager();
    const first = vi.fn(() => { throw new Error('subscriber failed'); });
    const second = vi.fn();
    h.manager.onTerminal('first', first);
    h.manager.onTerminal('second', second);
    expect(() => h.manager.shutdown()).toThrow(AggregateError);
    expect(first).toHaveBeenCalledWith(null, true);
    expect(second).toHaveBeenCalledWith(null, true);
    expect(await h.manager.waitForIdle(100)).toBe(true);
  });

  it('does not let a duplicate native exit remove an already-replaced terminal', async () => {
    const h = makeManager();
    await h.manager.getOrLaunch(sampleSession());
    const oldExit = h.env.captureExit();
    oldExit(0);
    const replacement = await h.manager.getOrLaunch(sampleSession());
    oldExit(1);
    expect(h.manager.get('sess-1')).toBe(replacement);
    expect(h.ended).toMatchObject([{ status: 'completed', exitCode: 0 }]);
    h.manager.close('sess-1');
    h.env.emitExit(0);
    expect(await h.manager.waitForIdle(100)).toBe(true);
  });

  it('keeps a completed terminal owned until its transcript is durable', async () => {
    let finish!: () => void;
    const h = makeManager('', false, undefined, {}, undefined, {
      save: () => new Promise<void>((resolve) => { finish = resolve; }),
    });
    await h.manager.getOrLaunch(sampleSession());
    h.env.emitExit(0);
    expect(await h.manager.waitForIdle(1)).toBe(false);
    expect(h.ended).toEqual([]);
    const replacement = h.manager.getOrLaunch(sampleSession());
    await Promise.resolve();
    expect(h.env.requests).toHaveLength(1);
    finish();
    await replacement;
    expect(h.ended).toMatchObject([{ status: 'completed' }]);
    expect(h.env.requests).toHaveLength(2);
    h.manager.close('sess-1');
    h.env.emitExit(0);
    expect(await h.manager.waitForIdle(100)).toBe(true);
  });

  it('publishes and logs transcript failure rather than a successful terminal outcome', async () => {
    const failure = new Error('disk full');
    const h = makeManager('', false, undefined, {}, undefined, {
      save: async () => { throw failure; },
    });
    await h.manager.getOrLaunch(sampleSession());
    h.env.emitExit(0);
    expect(await h.manager.waitForIdle(100)).toBe(true);
    expect(h.ended).toMatchObject([{ status: 'failed', exitCode: 0 }]);
    expect(h.notices).toMatchObject([{ level: 'error', message: expect.stringContaining('could not be saved') }]);
    expect(h.logger.error).toHaveBeenCalledWith('Terminal completion failed', {
      sessionId: 'sess-1', error: failure,
    });
    expect(h.manager.get('sess-1')).toBeUndefined();
  });

  it('quiesces one session without confusing a kill request with exit', async () => {
    const h = makeManager();
    await h.manager.getOrLaunch(sampleSession());
    expect(await h.manager.quiesceSession('unrelated', 0)).toBe(true);
    expect(h.env.kills()).toBe(0);
    expect(await h.manager.quiesceSession('sess-1', 1)).toBe(false);
    expect(h.env.kills()).toBe(1);
    h.env.emitExit(0);
    expect(await h.manager.quiesceSession('sess-1', 100)).toBe(true);
    await expect(h.manager.getOrLaunch(sampleSession())).rejects.toThrow('cancelled');
    expect(h.saved).toEqual([]);
  });

  it('blocks feature admission while waiting for existing bootstrap work to settle', async () => {
    let finish!: (bootstrap: string) => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const h = makeManager('', false, undefined, {}, undefined, {
      compose: () => new Promise<string>((resolve) => { finish = resolve; enter(); }),
    });
    const launch = h.manager.getOrLaunch(sampleSession());
    await entered;
    expect(await h.manager.quiesceFeature('unrelated', 0)).toBe(true);
    expect(await h.manager.quiesceFeature('feat-1', 1)).toBe(false);
    await expect(h.manager.getOrLaunch({ ...sampleSession(), id: 'new-session' }))
      .rejects.toThrow('cancelled');
    finish('');
    await expect(launch).rejects.toThrow('cancelled');
    expect(await h.manager.quiesceFeature('feat-1', 100)).toBe(true);
    expect(h.env.requests).toEqual([]);
  });

  it('on exit emits session.ended (completed) and saves the transcript', async () => {
    const { manager, env, ended, saved } = makeManager();
    await manager.getOrLaunch(sampleSession());
    env.emitData('\u001b[32mwork done\u001b[0m');
    env.emitExit(0);
    expect(await manager.waitForIdle(100)).toBe(true);
    expect(ended).toHaveLength(1);
    expect(ended[0].status).toBe('completed');
    expect(ended[0].exitCode).toBe(0);
    expect(saved).toHaveLength(1);
    expect(saved[0].stdout).toEqual(['work done']);
    expect(manager.get('sess-1')).toBeUndefined();
  });

  it('marks non-zero exits as failed and allows relaunch afterwards', async () => {
    const { manager, env, ended } = makeManager();
    await manager.getOrLaunch(sampleSession());
    env.emitExit(1);
    expect(await manager.waitForIdle(100)).toBe(true);
    expect(ended[0].status).toBe('failed');
    await manager.getOrLaunch(sampleSession());
    expect(env.requests).toHaveLength(2);
  });

  it('get returns the live terminal and close kills it', async () => {
    const { manager, env } = makeManager();
    await manager.getOrLaunch(sampleSession());
    expect(manager.get('sess-1')).toBeDefined();
    manager.close('sess-1');
    expect(env.kills()).toBe(1);
  });

  it('detaches terminal listeners and drops empty listener sets', async () => {
    const h = makeManager();
    const first: string[] = [];
    const second: string[] = [];
    const detachFirst = h.manager.onTerminal('sess-1', (terminal) =>
      first.push(terminal ? 'live' : 'reconnecting'),
    );
    const detachSecond = h.manager.onTerminal('sess-1', (terminal) =>
      second.push(terminal ? 'live' : 'reconnecting'),
    );
    await h.manager.getOrLaunch(sampleSession());
    detachFirst();
    h.env.emitExit(0);
    await h.manager.getOrLaunch(sampleSession());
    detachSecond();
    h.env.emitExit(0);
    await h.manager.getOrLaunch(sampleSession());
    expect(first).toEqual(['live']);
    expect(second).toEqual(['live', 'live']);
  });

  it('close suppresses session.ended and reports session.discarded on exit', async () => {
    const { manager, env, ended, discarded, saved } = makeManager();
    await manager.getOrLaunch(sampleSession());
    manager.close('sess-1');
    // node-pty reports the kill asynchronously via onExit.
    env.emitExit(0);
    expect(ended).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(discarded).toEqual(['sess-1']);
    expect(manager.get('sess-1')).toBeUndefined();
  });

  it('close is a no-op for an unknown session', async () => {
    const { manager, env } = makeManager();
    manager.close('nope');
    expect(env.kills()).toBe(0);
  });

  it('close drops a session whose terminal already exited without re-killing', async () => {
    const { manager, env, ended } = makeManager();
    await manager.getOrLaunch(sampleSession());
    env.emitExit(0);
    expect(await manager.waitForIdle(100)).toBe(true);
    expect(ended).toHaveLength(1);
    manager.close('sess-1');
    // Already exited: no second kill, no discard.
    expect(env.kills()).toBe(0);
  });

  it('waits for the ready prompt, then seeds and submits with a discrete Enter', async () => {
    vi.useFakeTimers();
    try {
      const { manager, env, instructionCalls } =
        makeManager('Follow the rules.');
      await manager.getOrLaunch(sampleSession());
      expect(instructionCalls).toEqual(['sess-1']);
      // Output that does not match the ready prompt must not trigger seeding.
      env.emitData('booting up the CLI...');
      expect(env.writes).toEqual([]);
      // Once the ready prompt appears, the instruction block is written first,
      // without the submit keystroke, so the CLI does not coalesce a trailing
      // newline into the paste.
      env.emitData('type / for commands');
      expect(env.writes).toEqual(['Follow the rules.']);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(env.writes).toEqual([
        'Follow the rules.',
        terminalDefaults.instructionSeedSuffix,
      ]);
      expect(manager.get('sess-1')?.inputReadiness).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles a ready prompt already captured before the bootstrap listener attaches', async () => {
    vi.useFakeTimers();
    try {
      const h = makeManager('Follow the rules.');
      h.env.emitWhenExitHandlerRegisters('type / for commands');
      await expect(h.manager.getOrLaunch(sampleSession())).resolves.toBeDefined();
      expect(h.env.writes).toEqual(['Follow the rules.']);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(h.env.writes).toEqual([
        'Follow the rules.',
        terminalDefaults.instructionSeedSuffix,
      ]);
      expect(h.manager.get('sess-1')?.inputReadiness).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeds instructions after the ready timeout when no prompt is detected', async () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('Follow the rules.');
      await manager.getOrLaunch(sampleSession());
      expect(manager.get('sess-1')?.inputReadiness).toBe('pending');
      env.emitData('still booting, no prompt yet');
      expect(env.writes).toEqual([]);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedReadyTimeoutMs);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(env.writes).toEqual([
        'Follow the rules.',
        terminalDefaults.instructionSeedSuffix,
      ]);
      expect(manager.get('sess-1')?.inputReadiness).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not seed instructions if the terminal exits before the prompt', async () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('Follow the rules.');
      const terminal = await manager.getOrLaunch(sampleSession());
      env.emitExit(0);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedReadyTimeoutMs);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(env.writes).toEqual([]);
      expect(terminal.inputReadiness).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not submit the seeded instructions if the terminal exits mid-seed', async () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('Follow the rules.');
      const terminal = await manager.getOrLaunch(sampleSession());
      env.emitData('type / for commands');
      expect(env.writes).toEqual(['Follow the rules.']);
      expect(terminal.inputReadiness).toBe('pending');
      env.emitExit(0);
      expect(terminal.inputReadiness).toBe('closed');
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(env.writes).toEqual(['Follow the rules.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not seed when there are no instruction skills', async () => {
    const { manager, env } = makeManager('');
    await manager.getOrLaunch(sampleSession());
    expect(env.writes).toEqual([]);
    expect(manager.get('sess-1')?.inputReadiness).toBe('ready');
  });

  it('releases input readiness when bootstrap injection fails', async () => {
    vi.useFakeTimers();
    try {
      const pasteFailure = makeManager('Follow the rules.');
      await pasteFailure.manager.getOrLaunch(sampleSession());
      pasteFailure.env.failWrites(new Error('paste failed'));
      pasteFailure.env.emitData('type / for commands');
      expect(
        pasteFailure.manager.get('sess-1')?.inputReadiness,
      ).toBe('ready');

      const submitFailure = makeManager('Follow the rules.');
      await submitFailure.manager.getOrLaunch(sampleSession());
      submitFailure.env.emitData('type / for commands');
      submitFailure.env.failWrites(new Error('submit failed'));
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(
        submitFailure.manager.get('sess-1')?.inputReadiness,
      ).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not seed instructions for meta sessions', async () => {
    const { manager, env, instructionCalls } = makeManager('Follow the rules.');
    await manager.getOrLaunch({ ...sampleSession(), kind: 'meta' });
    expect(instructionCalls).toEqual([]);
    expect(env.writes).toEqual([]);
  });

  it('throws when the session references an unknown provider', async () => {
    const { manager } = makeManager();
    await expect(
      manager.getOrLaunch({ ...sampleSession(), provider: 'ghost' }),
    ).rejects.toThrow();
  });

  describe('output-scanner file tracking', () => {
    it('records files the provider scanner detects in terminal output', async () => {
      const { manager, env, recorded } = makeManager('', true);
      await manager.getOrLaunch(sampleSession());
      env.emitData('FILE: notes.md');
      env.emitData('some unrelated output');
      env.emitData('FILE: src/app.ts');
      expect(recorded).toEqual([
        { sessionId: 'sess-1', path: '/home/me/notes.md', tool: 'create' },
        { sessionId: 'sess-1', path: '/home/me/src/app.ts', tool: 'create' },
      ]);
    });

    it('emits session.file for each detected file so the UI refreshes live', async () => {
      const { manager, env, fileEvents } = makeManager('', true);
      await manager.getOrLaunch(sampleSession());
      env.emitData('FILE: notes.md');
      env.emitData('some unrelated output');
      env.emitData('FILE: src/app.ts');
      expect(fileEvents).toEqual([
        { sessionId: 'sess-1' },
        { sessionId: 'sess-1' },
      ]);
    });

    it('emits no session.file when the provider exposes no scanner', async () => {
      const { manager, env, fileEvents } = makeManager('', false);
      await manager.getOrLaunch(sampleSession());
      env.emitData('FILE: notes.md');
      expect(fileEvents).toEqual([]);
    });

    it('records nothing when the provider exposes no scanner', async () => {
      const { manager, env, recorded } = makeManager('', false);
      await manager.getOrLaunch(sampleSession());
      env.emitData('FILE: notes.md');
      expect(recorded).toEqual([]);
    });

    it('stops recording once the terminal exits', async () => {
      const { manager, env, recorded } = makeManager('', true);
      await manager.getOrLaunch(sampleSession());
      env.emitExit(0);
      expect(recorded).toEqual([]);
    });
  });

  describe('model-change tracking', () => {
    it('reports each model switch the provider scanner detects', async () => {
      const { manager, env, modelResolved } = makeManager('', false, undefined, {
        withModelScanner: true,
      });
      await manager.getOrLaunch(sampleSession());
      env.emitData('MODEL: claude-opus-4.8');
      env.emitData('some unrelated output');
      env.emitData('MODEL: gpt-5.4');
      expect(modelResolved).toEqual([
        { sessionId: 'sess-1', model: 'claude-opus-4.8' },
        { sessionId: 'sess-1', model: 'gpt-5.4' },
      ]);
    });

    it('reports nothing when the provider exposes no model scanner', async () => {
      const { manager, env, modelResolved } = makeManager('', false);
      await manager.getOrLaunch(sampleSession());
      env.emitData('MODEL: gpt-5.4');
      expect(modelResolved).toEqual([]);
    });

    it('does not attach a model scanner when no resolver is wired', async () => {
      const { manager, env, modelResolved } = makeManager('', false, undefined, {
        withModelScanner: true,
        trackModel: false,
      });
      await manager.getOrLaunch(sampleSession());
      env.emitData('MODEL: gpt-5.4');
      expect(modelResolved).toEqual([]);
    });

    it('detaches the model scanner once the terminal exits', async () => {
      const { manager, env, modelResolved } = makeManager('', false, undefined, {
        withModelScanner: true,
      });
      await manager.getOrLaunch(sampleSession());
      env.emitExit(0);
      expect(modelResolved).toEqual([]);
    });
  });

  describe('MCP error scanner', () => {
    it('emits a session.notice per failing MCP server the CLI reports', async () => {
      const { manager, env, notices } = makeManager('', false, undefined, {
        withMcpScanner: true,
      });
      await manager.getOrLaunch(sampleSession());
      env.emitData('MCPFAIL: Azure');
      env.emitData('some unrelated output');
      // Terminal exit must not disturb the already-emitted notices.
      env.emitExit(0);
      expect(notices).toEqual([
        {
          sessionId: 'sess-1',
          level: 'error',
          message: 'MCP server "Azure" failed to connect — boom',
        },
      ]);
    });

    it('reports nothing when the provider exposes no MCP-error scanner', async () => {
      const { manager, env, notices } = makeManager('', false);
      await manager.getOrLaunch(sampleSession());
      env.emitData('MCPFAIL: Azure');
      expect(notices).toEqual([]);
    });

    it('omits the reason detail when the CLI gives no reason', async () => {
      const { manager, env, notices } = makeManager('', false, undefined, {
        withMcpScanner: true,
      });
      await manager.getOrLaunch(sampleSession());
      env.emitData('MCPBARE: github');
      expect(notices).toEqual([
        {
          sessionId: 'sess-1',
          level: 'error',
          message: 'MCP server "github" failed to connect',
        },
      ]);
    });
  });

  describe('injectInstructions', () => {
    it('writes and submits into a live terminal, returning true', async () => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager('');
        await manager.getOrLaunch(sampleSession());
        const injected = manager.injectInstructions('sess-1', 'Apply this.');
        expect(injected).toBe(true);
        expect(env.writes).toEqual(['Apply this.']);
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        expect(env.writes).toEqual([
          'Apply this.',
          terminalDefaults.instructionSeedSuffix,
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows a status line for a labelled injection and none for a blank label', async () => {
      vi.useFakeTimers();
      try {
        const { manager } = makeManager('');
        const terminal = await manager.getOrLaunch(sampleSession());
        const output: string[] = [];
        terminal.attach({
          send: (data) => output.push(data),
          exit: () => {},
          suppressible: true,
        });
        manager.injectInstructions('sess-1', 'Apply this.', 'Workspace context');
        expect(output.join('')).toContain('Workspace context is getting applied');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        output.length = 0;
        // A blank label is a caller bug, not a reason to print empty chrome.
        manager.injectInstructions('sess-1', 'Apply this.', '   ');
        expect(output.join('')).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });

    it('invalidates prior replay authority before submitting a new instruction block', async () => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager(
          '',
          false,
          undefined,
          {},
          (line) => line.includes('503'),
          { configOverride: { autoRetryEnabled: true } },
        );
        const terminal = await manager.getOrLaunch(sampleSession());
        const output: string[] = [];
        terminal.attach({ send: (data) => output.push(data), exit: () => {} });
        manager.confirmReplaySafeRequest('sess-1', 'old prompt');
        expect(manager.injectInstructions('sess-1', 'Apply this.')).toBe(true);
        env.emitData('Execution failed: 503 Service Unavailable\n');
        vi.advanceTimersByTime(
          terminalDefaults.instructionSeedSubmitDelayMs +
            terminalDefaults.autoRetryBackoffMs,
        );
        expect(env.writes).toEqual([
          'Apply this.',
          terminalDefaults.instructionSeedSuffix,
        ]);
        expect(output.join('')).toContain('retry manually if needed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for the terminal to fall quiet before submitting', async () => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager('');
        await manager.getOrLaunch(sampleSession());
        manager.injectInstructions('sess-1', 'Apply this.');
        expect(env.writes).toEqual(['Apply this.']);
        // Output just before the quiet window elapses restarts the wait, so the
        // submit keystroke is deferred rather than lost mid-stream.
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs - 1);
        env.emitData('streaming response…');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs - 1);
        expect(env.writes).toEqual(['Apply this.']);
        // Once output stops for the full quiet window, the submit lands.
        vi.advanceTimersByTime(1);
        expect(env.writes).toEqual([
          'Apply this.',
          terminalDefaults.instructionSeedSuffix,
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('submits at the max-wait cap even if output never stops', async () => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager('');
        await manager.getOrLaunch(sampleSession());
        manager.injectInstructions('sess-1', 'Apply this.');
        // Continuous output keeps restarting the quiet window right up to the
        // cap, at which point the message is submitted regardless.
        const step = terminalDefaults.instructionSeedSubmitDelayMs - 1;
        for (let elapsed = 0; elapsed < terminalDefaults.instructionSeedSubmitMaxWaitMs; elapsed += step) {
          vi.advanceTimersByTime(step);
          env.emitData('tick');
        }
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitMaxWaitMs);
        expect(env.writes).toContain(terminalDefaults.instructionSeedSuffix);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not submit if the terminal exits before the submit delay', async () => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager('');
        await manager.getOrLaunch(sampleSession());
        manager.injectInstructions('sess-1', 'Apply this.');
        expect(env.writes).toEqual(['Apply this.']);
        env.emitExit(0);
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        expect(env.writes).toEqual(['Apply this.']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns false when no terminal is running for the session', async () => {
      const { manager, env } = makeManager('');
      expect(manager.injectInstructions('sess-1', 'Apply this.')).toBe(false);
      expect(env.writes).toEqual([]);
    });

    it('returns false for an empty instruction block', async () => {
      const { manager, env } = makeManager('');
      await manager.getOrLaunch(sampleSession());
      expect(manager.injectInstructions('sess-1', '')).toBe(false);
      expect(env.writes).toEqual([]);
    });

    it('returns false once the terminal has exited', async () => {
      const { manager, env } = makeManager('');
      await manager.getOrLaunch(sampleSession());
      env.emitExit(0);
      expect(manager.injectInstructions('sess-1', 'Apply this.')).toBe(false);
      expect(env.writes).toEqual([]);
    });
  });
});
