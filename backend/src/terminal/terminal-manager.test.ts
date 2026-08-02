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

function interactiveProvider(withScanner = false): IAIProvider {
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
) {
  const env = fakePtyEnv();
  const bus = createEventBus<SessionEventMap>();
  const providers = createProviderRegistry();
  providers.register(interactiveProvider(withScanner));
  const ts = fakeTranscriptStore();
  const started: Session[] = [];
  const ended: Session[] = [];
  const discarded: string[] = [];
  bus.on('session.started', (s) => started.push(s));
  bus.on('session.ended', (s) => ended.push(s));
  bus.on('session.discarded', (id) => discarded.push(id));
  const instructionCalls: string[] = [];
  const recorded: Array<{ sessionId: string; path: string; tool: string }> = [];
  const manager = createTerminalManager({
    spawner: env.spawner,
    providers,
    bus,
    clock: createClock(() => 0),
    config: terminalDefaults,
    transcriptStore: ts.store,
    bootstrap: {
      composeForSession: async (session) => {
        instructionCalls.push(session.id);
        if (bootstrapError) {
          throw bootstrapError;
        }
        return instructions;
      },
    },
    sessionFiles: {
      record: (sessionId, path, tool) => {
        recorded.push({ sessionId, path, tool });
      },
    },
    home: '/home/me',
  });
  return {
    manager,
    env,
    started,
    ended,
    discarded,
    saved: ts.saved,
    instructionCalls,
    recorded,
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
