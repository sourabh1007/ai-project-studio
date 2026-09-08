import { describe, it, expect } from 'vitest';
import { createAcpMetaRunner, type AcpTurnPool } from './acp-meta-runner.js';
import type { AcpTurnResult } from './acp-client.js';

function fakePool(
  behaviour: (request: {
    prompt: string;
    cwd?: string;
    deadlineAt?: number;
    timeoutMs?: number;
    onActivity?: (text: string) => void;
    onStart?: () => void;
    signal?: AbortSignal;
  }) => AcpTurnResult,
): {
  pool: AcpTurnPool;
  calls: {
    prompt: string;
    cwd?: string;
    deadlineAt?: number;
    timeoutMs?: number;
    purpose?: string;
    label?: string;
    signal?: AbortSignal;
  }[];
} {
  const calls: {
    prompt: string;
    cwd?: string;
    deadlineAt?: number;
    timeoutMs?: number;
    purpose?: string;
    label?: string;
    signal?: AbortSignal;
  }[] = [];
  const pool: AcpTurnPool = {
    run(request, context) {
      request.onStart?.();
      calls.push({
        prompt: request.prompt,
        cwd: request.cwd,
        deadlineAt: request.deadlineAt,
        timeoutMs: request.timeoutMs,
        purpose: context?.purpose,
        label: context?.label,
        signal: request.signal,
      });
      return Promise.resolve(behaviour(request));
    },
  };
  return { pool, calls };
}

const result = (text: string): AcpTurnResult => ({
  text,
  sessionId: 'acp-internal',
  stopReason: 'end_turn',
  usage: null,
});

function deps(
  pool: AcpTurnPool,
  overrides: Partial<Parameters<typeof createAcpMetaRunner>[0]> = {},
): Parameters<typeof createAcpMetaRunner>[0] {
  return {
    pool,
    newSessionId: () => 'sess-1',
    providerId: 'copilot',
    defaultModel: () => 'auto',
    ...overrides,
  };
}

describe('createAcpMetaRunner', () => {
  it('runs a turn inline and reports the minted session id via onStart', async () => {
    const { pool, calls } = fakePool(() => result('answer'));
    const runner = createAcpMetaRunner(deps(pool));
    const started: string[] = [];
    const controller = new AbortController();
    const out = await runner.runDetailed({
      featureId: 'f',
      prompt: 'the full prompt',
      cwd: 'C:\\repo',
      timeoutMs: 12_345,
      onStart: (id) => started.push(id),
      signal: controller.signal,
    });
    expect(out).toEqual({
      text: 'answer',
      sessionId: 'sess-1',
      transport: 'warm-acp',
      providerId: 'copilot',
      requestedModel: 'auto',
      resolvedModel: null,
      providerSessionId: 'acp-internal',
      usage: {
        inputTokens: null,
        outputTokens: null,
        nanoAiu: null,
        credits: null,
      },
    });
    expect(started).toEqual(['sess-1']);
    expect(calls).toEqual([
      {
        prompt: 'the full prompt',
        cwd: 'C:\\repo',
        deadlineAt: undefined,
        timeoutMs: 12_345,
        signal: controller.signal,
      },
    ]);
  });

  it('forwards an existing absolute deadline unchanged', async () => {
    const { pool, calls } = fakePool(() => result('answer'));
    const runner = createAcpMetaRunner(deps(pool));
    await runner.runDetailed({
      featureId: 'f',
      prompt: 'the full prompt',
      deadlineAt: 456,
      timeoutMs: 12_345,
    });
    expect(calls[0]?.deadlineAt).toBe(456);
  });

  it('buffers streamed chunks into whole activity lines and flushes the remainder', async () => {
    const activity: string[] = [];
    const { pool } = fakePool((request) => {
      request.onActivity?.('hel');
      request.onActivity?.('lo\nwor');
      request.onActivity?.('ld\n\n');
      request.onActivity?.('tail');
      return result('done');
    });
    const runner = createAcpMetaRunner(deps(pool, { newSessionId: () => 's' }));
    await runner.runDetailed({
      featureId: 'f',
      prompt: 'p',
      onActivity: (line) => activity.push(line),
    });
    // 'hello', 'world', an empty line (dropped), then flushed 'tail'.
    expect(activity).toEqual(['💬 hello', '💬 world', '💬 tail']);
  });

  it('does not flush an empty trailing buffer', async () => {
    const activity: string[] = [];
    const { pool } = fakePool((request) => {
      request.onActivity?.('only line\n');
      return result('done');
    });
    const runner = createAcpMetaRunner(deps(pool, { newSessionId: () => 's' }));
    await runner.runDetailed({
      featureId: 'f',
      prompt: 'p',
      onActivity: (line) => activity.push(line),
    });
    expect(activity).toEqual(['💬 only line']);
  });

  it('runs without an onActivity callback', async () => {
    const { pool } = fakePool((request) => {
      // No activity sink provided.
      expect(request.onActivity).toBeUndefined();
      return result('quiet');
    });
    const runner = createAcpMetaRunner(deps(pool, { newSessionId: () => 's' }));
    const out = await runner.runDetailed({ featureId: 'f', prompt: 'p' });
    expect(out.text).toBe('quiet');
  });

  it("attributes the turn to the request's purpose for the usage history", async () => {
    const { pool, calls } = fakePool(() => result('ok'));
    const runner = createAcpMetaRunner(
      deps(pool, { newSessionId: () => 's', purpose: 'general' }),
    );
    await runner.runDetailed({
      featureId: 'f',
      prompt: 'p',
      purpose: 'pr-review',
      label: 'PR review · problem statement',
    });
    expect(calls[0].purpose).toBe('pr-review');
    expect(calls[0].label).toBe('PR review · problem statement');
  });

  it("falls back to the pool's purpose when the request has none", async () => {
    const { pool, calls } = fakePool(() => result('ok'));
    const runner = createAcpMetaRunner(
      deps(pool, { newSessionId: () => 's', purpose: 'general' }),
    );
    await runner.runDetailed({ featureId: 'f', prompt: 'p' });
    expect(calls[0].purpose).toBe('general');
  });

  it('clips over-long lines', async () => {
    const activity: string[] = [];
    const long = 'x'.repeat(200);
    const { pool } = fakePool((request) => {
      request.onActivity?.(`${long}\n`);
      return result('done');
    });
    const runner = createAcpMetaRunner(deps(pool, { newSessionId: () => 's' }));
    await runner.runDetailed({
      featureId: 'f',
      prompt: 'p',
      onActivity: (line) => activity.push(line),
    });
    expect(activity[0].length).toBeLessThan(long.length);
    expect(activity[0].endsWith('…')).toBe(true);
  });

  it('preserves warm token usage when the provider reports it', async () => {
    const { pool } = fakePool(() => ({
      text: 'done',
      sessionId: 'provider-session',
      stopReason: 'end_turn',
      usage: { inputTokens: 11, outputTokens: 7 },
    }));
    const runner = createAcpMetaRunner(deps(pool));

    await expect(
      runner.runDetailed({ featureId: 'f', prompt: 'p' }),
    ).resolves.toMatchObject({
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        nanoAiu: null,
        credits: null,
      },
    });
  });
});
