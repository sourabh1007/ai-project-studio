import { describe, it, expect, vi } from 'vitest';
import { createMetaRunner } from './meta-runner.js';
import { metaDefaults } from './config.js';
import type {
  LaunchedSession,
  SessionLauncher,
} from '../session/session-launcher.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { Session, StartSessionRequest } from '../session/session-contract.js';
import type { Transcript } from '../session/transcript-capture.js';
import type { RunningSession, SessionEvent } from '../provider/provider-contract.js';

const metaSession: Session = {
  id: 'meta1',
  featureId: 'f1',
  name: null,
  provider: 'agency',
  requestedModel: 'auto',
  resolvedModel: null,
  status: 'completed',
  kind: 'meta',
  scope: 'internal',
  prompt: 'p',
  usageFilePath: 'u',
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  endedAt: null,
  exitCode: 0,
};

function harness(
  transcript: Transcript | null,
  options: {
    completionError?: Error;
    loadError?: Error;
    ended?: Partial<Session>;
    hangs?: boolean;
    kill?: () => void;
    timeoutMs?: number;
    events?: SessionEvent[];
    settings?: { get: () => { providerId: string; model: string } };
    beforeLaunch?: (request: StartSessionRequest) => Promise<void>;
  } = {},
) {
  let handler: ((event: SessionEvent) => void) | null = null;
  let resolveCompletion: ((session: Session) => void) | null = null;
  let rejectCompletion: ((error: Error) => void) | null = null;
  const requests: StartSessionRequest[] = [];
  const launcher: SessionLauncher = {
    start: async (request) => {
      requests.push(request);
      if (options.beforeLaunch) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error('Session launch cancelled'));
          request.signal?.addEventListener('abort', onAbort, { once: true });
          options.beforeLaunch!(request).then(
            () => {
              request.signal?.removeEventListener('abort', onAbort);
              resolve();
            },
            (error) => {
              request.signal?.removeEventListener('abort', onAbort);
              reject(error);
            },
          );
        });
      }
      if (request.signal?.aborted) {
        throw new Error('Session launch cancelled');
      }
      const running = {
        kill: options.kill ?? (() => undefined),
        onEvent: (eventHandler: (event: SessionEvent) => void) => {
          handler = eventHandler;
          for (const event of options.events ?? []) {
            eventHandler(event);
          }
        },
      } as unknown as RunningSession;
      const completion = options.hangs
        ? new Promise<Session>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
          })
        : options.completionError
          ? Promise.reject(options.completionError)
          : Promise.resolve({ ...metaSession, ...options.ended });
      const launched: LaunchedSession = {
        session: { ...metaSession, ...options.ended },
        running,
        completion,
      };
      return launched;
    },
  };
  const transcripts: TranscriptStore = {
    save: async () => undefined,
    load: async () => {
      if (options.loadError) {
        throw options.loadError;
      }
      return transcript;
    },
    delete: async () => undefined,
  };
  const runner = createMetaRunner({
    launcher,
    transcripts,
    config: { ...metaDefaults, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
    settings: options.settings,
  });
  return {
    runner,
    requests,
    emit: (event: SessionEvent) => handler?.(event),
    finish: () => resolveCompletion?.({ ...metaSession, ...options.ended }),
    failCompletion: (error: Error) => rejectCompletion?.(error),
  };
}

describe('meta-runner', () => {
  it('forwards the immutable app operation ID to cold native ownership', async () => {
    const h = harness({ sessionId: 'meta1', stdout: ['{"response":"answer"}'], stderr: [], exitCode: 0 });
    await h.runner.runDetailed({ operationId: 'app-operation', featureId: 'f', prompt: 'go' });
    expect(h.requests[0].operationId).toBe('app-operation');
  });
  it('launches a meta session and returns the extracted response', async () => {
    const h = harness({
      sessionId: 'meta1',
      stdout: [JSON.stringify({ response: 'the answer' })],
      stderr: [],
      exitCode: 0,
    });

    const result = await h.runner.run({ featureId: 'f1', prompt: 'do it' });

    expect(result).toBe('the answer');
    expect(h.requests[0]).toMatchObject({
      featureId: 'f1',
      providerId: metaDefaults.providerId,
      model: metaDefaults.model,
      prompt: 'do it',
      kind: 'meta',
    });
  });

  it('prefers the runtime settings provider/model over the static config', async () => {
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [JSON.stringify({ response: 'the answer' })],
        stderr: [],
        exitCode: 0,
      },
      { settings: { get: () => ({ providerId: 'copilot', model: 'gpt-5' }) } },
    );

    await h.runner.run({ featureId: 'f1', prompt: 'do it' });

    expect(h.requests[0]).toMatchObject({
      providerId: 'copilot',
      model: 'gpt-5',
    });
  });

  it('lets a request pin its own provider/model over the runtime settings', async () => {
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [JSON.stringify({ response: 'the answer' })],
        stderr: [],
        exitCode: 0,
      },
      { settings: { get: () => ({ providerId: 'agency', model: 'auto' }) } },
    );

    await h.runner.run({
      featureId: 'f1',
      providerId: 'copilot',
      model: 'gpt-5',
      prompt: 'do it',
    });

    expect(h.requests[0]).toMatchObject({
      providerId: 'copilot',
      model: 'gpt-5',
    });
  });

  it('forwards repository cwd, internal scope, and attachments to the shared launcher', async () => {
    const h = harness({
      sessionId: 'meta1',
      stdout: [JSON.stringify({ response: 'repository context' })],
      stderr: [],
      exitCode: 0,
    });

    await expect(
      h.runner.run({
        featureId: 'repository:repo-1',
        prompt: 'analyze',
        attachments: ['C:\\Temp\\aps-a\\p.pdf'],
        cwd: 'C:\\work\\repo',
        scope: 'internal',
        noTools: true,
      }),
    ).resolves.toBe('repository context');

    expect(h.requests[0]).toMatchObject({
      featureId: 'repository:repo-1',
      cwd: 'C:\\work\\repo',
      scope: 'internal',
      attachments: ['C:\\Temp\\aps-a\\p.pdf'],
      kind: 'meta',
      noTools: true,
    });
  });

  it('returns an empty string when the meta session captured nothing', async () => {
    const h = harness(null);
    expect(await h.runner.run({ featureId: 'f1', prompt: 'do it' })).toBe('');
  });

  it('does not launch when the request signal is already aborted', async () => {
    const h = harness(null);
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it', signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'MetaAbortError',
      message: 'Meta request cancelled before it started',
    });
    expect(h.requests).toHaveLength(0);
  });

  it('fails immediately when the request deadline has already expired', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const h = harness(null);
      const controller = new AbortController();
      await expect(
        h.runner.runDetailed({
          featureId: 'f1',
          prompt: 'do it',
          timeoutMs: 50,
          deadlineAt: Date.now(),
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        name: 'MetaAbortError',
        kind: 'timed_out',
        termination: 'not-started',
      });
      expect(h.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows launcher failures that were not caused by cancellation', async () => {
    const launcher: SessionLauncher = {
      start: async () => {
        throw new Error('launch boom');
      },
    };
    const runner = createMetaRunner({
      launcher,
      transcripts: {
        save: async () => undefined,
        load: async () => null,
        delete: async () => undefined,
      },
      config: metaDefaults,
    });
    await expect(
      runner.runDetailed({ featureId: 'f1', prompt: 'do it' }),
    ).rejects.toThrow('launch boom');
  });

  it('propagates session and transcript failures', async () => {
    await expect(
      harness(null, { completionError: new Error('provider failed') }).runner.run({
        featureId: 'f1',
        prompt: 'do it',
      }),
    ).rejects.toThrow('provider failed');

    await expect(
      harness(null, { loadError: new Error('transcript failed') }).runner.run({
        featureId: 'f1',
        prompt: 'do it',
      }),
    ).rejects.toThrow('transcript failed');
  });

  it('surfaces concise failed-session stderr instead of extracting stdout', async () => {
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: ['[]'],
        stderr: [
          'warning',
          '\u001b[31m--attachment file type not supported: C:\\very\\long\\p.md\u001b[0m',
        ],
        exitCode: 1,
      },
      { ended: { status: 'failed', exitCode: 1 } },
    );

    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).rejects.toThrow(
      'Provider failed (exit code 1): --attachment file type not supported',
    );
  });

  it('prefers the final session.error and safely caps provider failures', async () => {
    const long = `specific ${'x'.repeat(600)}`;
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [
          JSON.stringify({ type: 'session.error', data: { message: 'old' } }),
          JSON.stringify({ type: 'session.error', data: { error: long } }),
        ],
        stderr: ['generic stderr'],
        exitCode: 2,
      },
      { ended: { status: 'completed', exitCode: 2 } },
    );

    let failure: Error | undefined;
    try {
      await h.runner.run({ featureId: 'f1', prompt: 'do it' });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain('specific');
    expect(failure?.message).not.toContain('generic stderr');
    expect(failure?.message.endsWith('…')).toBe(true);
    expect(failure!.message.length).toBeLessThanOrEqual(532);
  });

  it('uses a generic provider failure when no diagnostic was captured', async () => {
    const h = harness(null, { ended: { status: 'failed', exitCode: null } });
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).rejects.toThrow('Provider failed');
  });

  it('accepts only valid session.error diagnostics', async () => {
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [
          'not json',
          JSON.stringify({ type: 'session.start', data: {} }),
          JSON.stringify({ type: 'session.error', data: null }),
          JSON.stringify({ type: 'session.error', data: { message: 42 } }),
          JSON.stringify({
            type: 'session.error',
            data: { message: '', content: 'final safe detail' },
          }),
        ],
        stderr: [],
        exitCode: 1,
      },
      { ended: { status: 'failed', exitCode: 1 } },
    );
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).rejects.toThrow('final safe detail');
  });

  it('reports the session id on start and streams described activity lines', async () => {
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [JSON.stringify({ response: 'done' })],
        stderr: [],
        exitCode: 0,
      },
      {
        events: [
          { type: 'stdout', line: JSON.stringify({ type: 'assistant.message', data: { content: 'hi' } }) },
          { type: 'stdout', line: JSON.stringify({ type: 'assistant.message_delta', data: { content: 'x' } }) },
          { type: 'stderr', line: 'a diagnostic' },
          { type: 'exit', code: 0 },
        ],
      },
    );

    const started: string[] = [];
    const activity: string[] = [];
    await h.runner.runDetailed({
      featureId: 'f1',
      prompt: 'do it',
      onStart: (id) => started.push(id),
      onActivity: (line) => activity.push(line),
    });

    expect(started).toEqual(['meta1']);
    // The delta is dropped; the assistant message and stderr diagnostic remain.
    expect(activity).toEqual(['💬 hi', '· a diagnostic']);
  });

  it('kills the provider and fails when a session exceeds the timeout', async () => {
    let killed = 0;
    const h = harness(null, {
      hangs: true,
      timeoutMs: 5,
      kill: () => {
        killed += 1;
      },
    });
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).rejects.toThrow('Provider timed out after 5ms');
    expect(killed).toBe(1);
  });

  it('honors a per-request timeout override over the configured ceiling', async () => {
    let killed = 0;
    const h = harness(null, {
      hangs: true,
      timeoutMs: 100_000,
      kill: () => {
        killed += 1;
      },
    });
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it', timeoutMs: 5 }),
    ).rejects.toThrow('Provider timed out after 5ms');
    expect(killed).toBe(1);
  });

  it('spends the timeout budget across launch and execution, not just execution', async () => {
    vi.useFakeTimers();
    try {
      let releaseLaunch: () => void = () => undefined;
      const h = harness(null, {
        hangs: true,
        timeoutMs: 100,
        beforeLaunch: async () =>
          new Promise<void>((resolve) => {
            releaseLaunch = resolve;
          }),
      });
      const run = h.runner.run({
        featureId: 'f1',
        prompt: 'do it',
        timeoutMs: 50,
      });
      run.catch(() => undefined);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await expect(run).rejects.toThrow('Provider timed out after 50ms before it started');
      releaseLaunch();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces an aborted launch distinctly from a timed-out launch', async () => {
    let releaseLaunch: () => void = () => undefined;
    const controller = new AbortController();
    const h = harness(null, {
      beforeLaunch: async () =>
        new Promise<void>((resolve) => {
          releaseLaunch = resolve;
        }),
    });
    const run = h.runner.runDetailed({
      featureId: 'f1',
      prompt: 'do it',
      signal: controller.signal,
    });
    run.catch(() => undefined);
    await Promise.resolve();
    controller.abort();
    releaseLaunch();
    await expect(run).rejects.toMatchObject({
      name: 'MetaAbortError',
      kind: 'aborted',
      termination: 'not-started',
    });
  });

  it('stops forwarding late activity once the request is cancelled', async () => {
    vi.useFakeTimers();
    try {
      let killed = 0;
      const h = harness(
        {
          sessionId: 'meta1',
          stdout: [JSON.stringify({ response: 'the answer' })],
          stderr: [],
          exitCode: 1,
        },
        {
          hangs: true,
          kill: () => {
            killed += 1;
          },
        },
      );
      const controller = new AbortController();
      const activity: string[] = [];
      const run = h.runner.runDetailed({
        featureId: 'f1',
        prompt: 'do it',
        signal: controller.signal,
        onActivity: (line) => activity.push(line),
      });
      run.catch(() => undefined);
      controller.abort();
      h.emit({ type: 'stdout', line: JSON.stringify({ type: 'assistant.message', data: { content: 'late' } }) });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(run).rejects.toThrow(
        'Meta request cancelled; termination was requested but not confirmed',
      );
      expect(activity).toEqual([]);
      expect(killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the first cancellation request when the internal launch signal fires twice', async () => {
    let killed = 0;
    const h = harness(null, {
      hangs: true,
      kill: () => {
        killed += 1;
      },
    });
    const run = h.runner.runDetailed({ featureId: 'f1', prompt: 'do it' });
    run.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    const signal = h.requests[0]?.signal as AbortSignal & EventTarget;
    signal.dispatchEvent(new Event('abort'));
    signal.dispatchEvent(new Event('abort'));
    expect(killed).toBe(1);
    h.failCompletion(new Error('provider killed'));
    await expect(run).rejects.toMatchObject({
      name: 'MetaAbortError',
      kind: 'aborted',
      termination: 'confirmed',
    });
  });

  it('ignores a late successful completion after cancellation already timed out waiting for exit', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(null, {
        hangs: true,
        kill: () => undefined,
      });
      const controller = new AbortController();
      const run = h.runner.runDetailed({
        featureId: 'f1',
        prompt: 'do it',
        signal: controller.signal,
      });
      run.catch(() => undefined);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(run).rejects.toMatchObject({
        name: 'MetaAbortError',
        kind: 'aborted',
        termination: 'unconfirmed',
      });
      h.finish();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late failed completion after cancellation already timed out waiting for exit', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(null, {
        hangs: true,
        kill: () => undefined,
      });
      const controller = new AbortController();
      const run = h.runner.runDetailed({
        featureId: 'f1',
        prompt: 'do it',
        signal: controller.signal,
      });
      run.catch(() => undefined);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(run).rejects.toMatchObject({
        name: 'MetaAbortError',
        kind: 'aborted',
        termination: 'unconfirmed',
      });
      h.failCompletion(new Error('late failure'));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a confirmed cancellation when the provider later rejects after kill', async () => {
    const h = harness(null, {
      hangs: true,
      kill: () => undefined,
    });
    const controller = new AbortController();
    const run = h.runner.runDetailed({
      featureId: 'f1',
      prompt: 'do it',
      signal: controller.signal,
    });
    run.catch(() => undefined);
    controller.abort();
    h.failCompletion(new Error('provider failed during shutdown'));
    await expect(run).rejects.toMatchObject({
      name: 'MetaAbortError',
      kind: 'aborted',
      termination: 'confirmed',
    });
  });

  it('reports confirmed cancellation once the killed provider exits', async () => {
    let killed = 0;
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [JSON.stringify({ response: 'the answer' })],
        stderr: [],
        exitCode: 1,
      },
      {
        hangs: true,
        kill: () => {
          killed += 1;
          h.finish();
        },
      },
    );
    const controller = new AbortController();
    const run = h.runner.run({
      featureId: 'f1',
      prompt: 'do it',
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toMatchObject({
      name: 'MetaAbortError',
      termination: 'confirmed',
      message: 'Meta request cancelled',
    });
    expect(killed).toBe(1);
  });

  it('still times out gracefully when killing the wedged process throws', async () => {
    const h = harness(null, {
      hangs: true,
      timeoutMs: 5,
      kill: () => {
        throw new Error('already dead');
      },
    });
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).rejects.toThrow('Provider timed out after 5ms');
  });

  it('finishes as soon as the CLI emits its terminal result event', async () => {
    let killed = 0;
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [JSON.stringify({ response: 'the answer' })],
        stderr: [],
        exitCode: 143,
      },
      {
        // The process is killed by the terminal-event fast path, so completion
        // resolves with a non-zero (killed) exit code that must NOT be treated
        // as a provider failure.
        ended: { status: 'completed', exitCode: 143 },
        kill: () => {
          killed += 1;
        },
        events: [
          { type: 'stdout', line: '' },
          { type: 'stdout', line: 'plain diagnostic' },
          { type: 'stdout', line: '{ not json' },
          { type: 'stdout', line: JSON.stringify({ type: 'assistant.idle' }) },
          { type: 'stderr', line: JSON.stringify({ type: 'result' }) },
          { type: 'stdout', line: JSON.stringify({ type: 'result', data: {} }) },
          { type: 'exit', code: 143 },
        ],
      },
    );

    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).resolves.toBe('the answer');
    // The terminal `result` line triggers exactly one kill; the `result` on
    // stderr and the non-result stdout lines do not.
    expect(killed).toBe(1);
  });

  it('finishes the turn even when killing after the terminal event throws', async () => {
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: [JSON.stringify({ response: 'the answer' })],
        stderr: [],
        exitCode: 143,
      },
      {
        ended: { status: 'completed', exitCode: 143 },
        kill: () => {
          throw new Error('already exiting');
        },
        events: [{ type: 'stdout', line: JSON.stringify({ type: 'result', data: {} }) }],
      },
    );
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).resolves.toBe('the answer');
  });

  it('still fails a non-zero exit when no terminal result event was seen', async () => {
    const h = harness(
      {
        sessionId: 'meta1',
        stdout: ['[]'],
        stderr: ['boom'],
        exitCode: 1,
      },
      {
        ended: { status: 'completed', exitCode: 1 },
        events: [{ type: 'stdout', line: JSON.stringify({ type: 'assistant.message', data: {} }) }],
      },
    );
    await expect(
      h.runner.run({ featureId: 'f1', prompt: 'do it' }),
    ).rejects.toThrow('Provider failed (exit code 1): boom');
  });
});
