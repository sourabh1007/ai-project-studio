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

function fakePtyEnv() {
  const requests: PtySpawnRequest[] = [];
  const writes: string[] = [];
  let dataCb: (d: string) => void = () => {};
  let exitCb: (c: number | null) => void = () => {};
  let kills = 0;
  const pty: PtyProcess = {
    write: (d) => {
      writes.push(d);
    },
    resize: () => {},
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
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

function makeManager(instructions = '', withScanner = false) {
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
    skills: {
      instructionsForSession: (id) => {
        instructionCalls.push(id);
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
  it('launches the interactive CLI in a PTY and emits session.started', () => {
    const { manager, env, started } = makeManager();
    const terminal = manager.getOrLaunch(sampleSession(), {
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

  it('falls back to default terminal size when unspecified', () => {
    const { manager, env } = makeManager();
    manager.getOrLaunch(sampleSession());
    expect(env.requests[0].cols).toBe(terminalDefaults.defaultCols);
    expect(env.requests[0].rows).toBe(terminalDefaults.defaultRows);
  });

  it('reuses the running terminal instead of relaunching', () => {
    const { manager, env } = makeManager();
    const first = manager.getOrLaunch(sampleSession());
    const second = manager.getOrLaunch(sampleSession());
    expect(second).toBe(first);
    expect(env.requests).toHaveLength(1);
  });

  it('on exit emits session.ended (completed) and saves the transcript', () => {
    const { manager, env, ended, saved } = makeManager();
    manager.getOrLaunch(sampleSession());
    env.emitData('\u001b[32mwork done\u001b[0m');
    env.emitExit(0);
    expect(ended).toHaveLength(1);
    expect(ended[0].status).toBe('completed');
    expect(ended[0].exitCode).toBe(0);
    expect(saved).toHaveLength(1);
    expect(saved[0].stdout).toEqual(['work done']);
    expect(manager.get('sess-1')).toBeUndefined();
  });

  it('marks non-zero exits as failed and allows relaunch afterwards', () => {
    const { manager, env, ended } = makeManager();
    manager.getOrLaunch(sampleSession());
    env.emitExit(1);
    expect(ended[0].status).toBe('failed');
    manager.getOrLaunch(sampleSession());
    expect(env.requests).toHaveLength(2);
  });

  it('get returns the live terminal and close kills it', () => {
    const { manager, env } = makeManager();
    manager.getOrLaunch(sampleSession());
    expect(manager.get('sess-1')).toBeDefined();
    manager.close('sess-1');
    expect(env.kills()).toBe(1);
  });

  it('close suppresses session.ended and reports session.discarded on exit', () => {
    const { manager, env, ended, discarded, saved } = makeManager();
    manager.getOrLaunch(sampleSession());
    manager.close('sess-1');
    // node-pty reports the kill asynchronously via onExit.
    env.emitExit(0);
    expect(ended).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(discarded).toEqual(['sess-1']);
    expect(manager.get('sess-1')).toBeUndefined();
  });

  it('close is a no-op for an unknown session', () => {
    const { manager, env } = makeManager();
    manager.close('nope');
    expect(env.kills()).toBe(0);
  });

  it('close drops a session whose terminal already exited without re-killing', () => {
    const { manager, env, ended } = makeManager();
    manager.getOrLaunch(sampleSession());
    env.emitExit(0);
    expect(ended).toHaveLength(1);
    manager.close('sess-1');
    // Already exited: no second kill, no discard.
    expect(env.kills()).toBe(0);
  });

  it('waits for the ready prompt, then seeds and submits with a discrete Enter', () => {
    vi.useFakeTimers();
    try {
      const { manager, env, instructionCalls } =
        makeManager('Follow the rules.');
      manager.getOrLaunch(sampleSession());
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
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeds instructions after the ready timeout when no prompt is detected', () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('Follow the rules.');
      manager.getOrLaunch(sampleSession());
      env.emitData('still booting, no prompt yet');
      expect(env.writes).toEqual([]);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedReadyTimeoutMs);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(env.writes).toEqual([
        'Follow the rules.',
        terminalDefaults.instructionSeedSuffix,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not seed instructions if the terminal exits before the prompt', () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('Follow the rules.');
      manager.getOrLaunch(sampleSession());
      env.emitExit(0);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedReadyTimeoutMs);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(env.writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not submit the seeded instructions if the terminal exits mid-seed', () => {
    vi.useFakeTimers();
    try {
      const { manager, env } = makeManager('Follow the rules.');
      manager.getOrLaunch(sampleSession());
      env.emitData('type / for commands');
      expect(env.writes).toEqual(['Follow the rules.']);
      env.emitExit(0);
      vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
      expect(env.writes).toEqual(['Follow the rules.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not seed when there are no instruction skills', () => {
    const { manager, env } = makeManager('');
    manager.getOrLaunch(sampleSession());
    expect(env.writes).toEqual([]);
  });

  it('does not seed instructions for meta sessions', () => {
    const { manager, env, instructionCalls } = makeManager('Follow the rules.');
    manager.getOrLaunch({ ...sampleSession(), kind: 'meta' });
    expect(instructionCalls).toEqual([]);
    expect(env.writes).toEqual([]);
  });

  it('throws when the session references an unknown provider', () => {
    const { manager } = makeManager();
    expect(() =>
      manager.getOrLaunch({ ...sampleSession(), provider: 'ghost' }),
    ).toThrow();
  });

  describe('output-scanner file tracking', () => {
    it('records files the provider scanner detects in terminal output', () => {
      const { manager, env, recorded } = makeManager('', true);
      manager.getOrLaunch(sampleSession());
      env.emitData('FILE: notes.md');
      env.emitData('some unrelated output');
      env.emitData('FILE: src/app.ts');
      expect(recorded).toEqual([
        { sessionId: 'sess-1', path: '/home/me/notes.md', tool: 'create' },
        { sessionId: 'sess-1', path: '/home/me/src/app.ts', tool: 'create' },
      ]);
    });

    it('records nothing when the provider exposes no scanner', () => {
      const { manager, env, recorded } = makeManager('', false);
      manager.getOrLaunch(sampleSession());
      env.emitData('FILE: notes.md');
      expect(recorded).toEqual([]);
    });

    it('stops recording once the terminal exits', () => {
      const { manager, env, recorded } = makeManager('', true);
      manager.getOrLaunch(sampleSession());
      env.emitExit(0);
      expect(recorded).toEqual([]);
    });
  });

  describe('injectInstructions', () => {
    it('writes and submits into a live terminal, returning true', () => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager('');
        manager.getOrLaunch(sampleSession());
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

    it('does not submit if the terminal exits before the submit delay', () => {
      vi.useFakeTimers();
      try {
        const { manager, env } = makeManager('');
        manager.getOrLaunch(sampleSession());
        manager.injectInstructions('sess-1', 'Apply this.');
        expect(env.writes).toEqual(['Apply this.']);
        env.emitExit(0);
        vi.advanceTimersByTime(terminalDefaults.instructionSeedSubmitDelayMs);
        expect(env.writes).toEqual(['Apply this.']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns false when no terminal is running for the session', () => {
      const { manager, env } = makeManager('');
      expect(manager.injectInstructions('sess-1', 'Apply this.')).toBe(false);
      expect(env.writes).toEqual([]);
    });

    it('returns false for an empty instruction block', () => {
      const { manager, env } = makeManager('');
      manager.getOrLaunch(sampleSession());
      expect(manager.injectInstructions('sess-1', '')).toBe(false);
      expect(env.writes).toEqual([]);
    });

    it('returns false once the terminal has exited', () => {
      const { manager, env } = makeManager('');
      manager.getOrLaunch(sampleSession());
      env.emitExit(0);
      expect(manager.injectInstructions('sess-1', 'Apply this.')).toBe(false);
      expect(env.writes).toEqual([]);
    });
  });
});
