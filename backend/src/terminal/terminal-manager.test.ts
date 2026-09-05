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
    kills: () => kills,
    failWrites: (error?: Error) => {
      writeError = error;
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
  const manager = createTerminalManager({
    spawner: env.spawner,
    providers,
    bus,
    clock: createClock(() => 0),
    config: extra.configOverride
      ? { ...terminalDefaults, ...extra.configOverride }
      : terminalDefaults,
    transcriptStore: ts.store,
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
        return instructions;
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
  };
}

describe('createTerminalManager', () => {
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

  it('auto-retries the last typed prompt on a transient provider failure', async () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('', false, undefined, {}, (line) =>
        line.includes('503'),
      );
      await manager.getOrLaunch(sampleSession());
      // The reviewer types a prompt; the ws-server routes keystrokes to the
      // manager, which feeds the per-session auto-retry controller.
      manager.observeInput('sess-1', 'fix it\r');
      // The interactive CLI reports a transient provider failure on its output.
      env.emitData('Execution failed: 503 Service Unavailable\n');
      // After the backoff the manager re-submits the same prompt via the PTY.
      vi.advanceTimersByTime(terminalDefaults.autoRetryBackoffMs);
      expect(env.writes).toContain('fix it');
      // The session exiting tears the controller's output sink down cleanly.
      env.emitExit(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-retry when no transient classifier is provided', async () => {
    const { manager, env } = makeManager();
    await manager.getOrLaunch(sampleSession());
    // Without a classifier the controller is never attached, so routed input
    // is a harmless no-op and no resend is written.
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
        },
      );
      return { ...h, report };
    }

    it('restarts the CLI and replays the prompt once re-submits are spent', async () => {
      const analyze = vi
        .fn<(text: string) => Promise<string | null>>()
        .mockResolvedValue('History too large; a restart clears it.');
      const h = makeSelfRecovering({ analyze });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');

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

    it('replays the last prompt after the relaunched CLI is ready', async () => {
      vi.useFakeTimers();
      try {
        const h = makeSelfRecovering();
        await h.manager.getOrLaunch(sampleSession());
        h.manager.observeInput('sess-1', 'try again\r');
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

    it('reports to the status bar when the restart cannot be carried out', async () => {
      // Fail the second compose (the relaunch) so restartSession returns false.
      const h = makeSelfRecovering({ composeFailOnCall: 2 });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
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

    it('notes analysis was unavailable when the metasession cannot start and restart fails', async () => {
      const analyze = vi
        .fn<(text: string) => Promise<string | null>>()
        .mockRejectedValue(new Error('meta down'));
      const h = makeSelfRecovering({ analyze, composeFailOnCall: 2 });
      await h.manager.getOrLaunch(sampleSession());
      h.manager.observeInput('sess-1', 'do it\r');
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
    });

    it('re-seeds bootstrap context then replays the prompt on restart', async () => {
      vi.useFakeTimers();
      try {
        const h = makeSelfRecovering({ instructions: 'Follow the rules.' });
        await h.manager.getOrLaunch(sampleSession());
        // Clear the launch-time bootstrap seeding on the first terminal.
        h.env.emitData('type / for commands');
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        h.manager.observeInput('sess-1', 'try again\r');

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

  it('shutdown kills every live terminal without emitting session.ended', async () => {
    const { manager, env, ended, discarded } = makeManager();
    await manager.getOrLaunch(sampleSession());
    manager.shutdown();
    expect(env.kills()).toBe(1);
    // A subsequent exit from the killed PTY is reported as discarded, not ended.
    env.emitExit(0);
    expect(ended).toHaveLength(0);
    expect(discarded).toEqual(['sess-1']);
  });

  it('on exit emits session.ended (completed) and saves the transcript', async () => {
    const { manager, env, ended, saved } = makeManager();
    await manager.getOrLaunch(sampleSession());
    env.emitData('\u001b[32mwork done\u001b[0m');
    env.emitExit(0);
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
