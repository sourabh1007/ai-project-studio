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

function fakeRunning() {
  let handler: ((e: SessionEvent) => void) | undefined;
  let resolveDone!: (code: number | null) => void;
  const done = new Promise<number | null>((r) => {
    resolveDone = r;
  });
  const running: RunningSession = {
    sessionId: 'ignored',
    onEvent: (h) => {
      handler = h;
    },
    kill: () => {},
    done,
  };
  return {
    running,
    emit: (e: SessionEvent) => handler?.(e),
    finish: (code: number | null) => {
      handler?.({ type: 'exit', code });
      resolveDone(code);
    },
  };
}

function harness(options: { failSave?: boolean } = {}) {
  const rs = fakeRunning();
  let capturedSpec: SessionSpec | undefined;
  const provider: IAIProvider = {
    id: 'copilot',
    listModels: async () => [
      { id: 'auto', label: 'Auto' },
      { id: 'gpt-5.4', label: 'G' },
    ],
    startSession: (spec) => {
      capturedSpec = spec;
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
  const outputs: { sessionId: string; event: SessionEvent }[] = [];
  bus.on('session.started', (s) => started.push(s));
  bus.on('session.ended', (s) => ended.push(s));
  bus.on('session.output', (o) => outputs.push(o));

  const launcher = createSessionLauncher({
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
  });

  return { rs, launcher, saved, started, ended, outputs, getSpec: () => capturedSpec };
}

describe('session-launcher', () => {
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

    h.rs.emit({ type: 'stdout', line: 'hi there' });
    h.rs.finish(0);

    const final = await launched.completion;
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    expect(final.endedAt).toBe('2025-01-01T00:00:05.000Z');
    expect(h.outputs).toEqual([
      { sessionId: 'sess-1', event: { type: 'stdout', line: 'hi there' } },
      { sessionId: 'sess-1', event: { type: 'exit', code: 0 } },
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

  it('applies the default kind and forwards cwd', async () => {
    const h = harness();
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
      cwd: '/work',
    });
    expect(launched.session.kind).toBe('dev');
    expect(h.getSpec()!.cwd).toBe('/work');
    h.rs.finish(0);
    await launched.completion;
  });

  it('rejects completion when the transcript save fails, without an unhandled rejection', async () => {
    const h = harness({ failSave: true });
    const launched = await h.launcher.start({
      featureId: 'feat-1',
      prompt: 'hello',
    });
    h.rs.finish(0);
    await expect(launched.completion).rejects.toThrow('disk full');
  });
});
