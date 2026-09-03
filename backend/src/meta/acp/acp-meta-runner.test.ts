import { describe, it, expect } from 'vitest';
import { createAcpMetaRunner, type AcpTurnPool } from './acp-meta-runner.js';
import type { AcpTurnResult } from './acp-client.js';

function fakePool(
  behaviour: (request: {
    prompt: string;
    cwd?: string;
    onActivity?: (text: string) => void;
  }) => AcpTurnResult,
): {
  pool: AcpTurnPool;
  calls: { prompt: string; cwd?: string; purpose?: string }[];
} {
  const calls: { prompt: string; cwd?: string; purpose?: string }[] = [];
  const pool: AcpTurnPool = {
    run(request, context) {
      calls.push({
        prompt: request.prompt,
        cwd: request.cwd,
        purpose: context?.purpose,
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

describe('createAcpMetaRunner', () => {
  it('runs a turn inline and reports the minted session id via onStart', async () => {
    const { pool, calls } = fakePool(() => result('answer'));
    const runner = createAcpMetaRunner({ pool, newSessionId: () => 'sess-1' });
    const started: string[] = [];
    const out = await runner.runDetailed({
      featureId: 'f',
      prompt: 'the full prompt',
      cwd: 'C:\\repo',
      onStart: (id) => started.push(id),
    });
    expect(out).toEqual({ text: 'answer', sessionId: 'sess-1' });
    expect(started).toEqual(['sess-1']);
    expect(calls).toEqual([{ prompt: 'the full prompt', cwd: 'C:\\repo' }]);
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
    const runner = createAcpMetaRunner({ pool, newSessionId: () => 's' });
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
    const runner = createAcpMetaRunner({ pool, newSessionId: () => 's' });
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
    const runner = createAcpMetaRunner({ pool, newSessionId: () => 's' });
    const out = await runner.runDetailed({ featureId: 'f', prompt: 'p' });
    expect(out.text).toBe('quiet');
  });

  it("attributes the turn to the request's purpose for the usage history", async () => {
    const { pool, calls } = fakePool(() => result('ok'));
    const runner = createAcpMetaRunner({
      pool,
      newSessionId: () => 's',
      purpose: 'general',
    });
    await runner.runDetailed({ featureId: 'f', prompt: 'p', purpose: 'pr-review' });
    expect(calls[0].purpose).toBe('pr-review');
  });

  it("falls back to the pool's purpose when the request has none", async () => {
    const { pool, calls } = fakePool(() => result('ok'));
    const runner = createAcpMetaRunner({
      pool,
      newSessionId: () => 's',
      purpose: 'general',
    });
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
    const runner = createAcpMetaRunner({ pool, newSessionId: () => 's' });
    await runner.runDetailed({
      featureId: 'f',
      prompt: 'p',
      onActivity: (line) => activity.push(line),
    });
    expect(activity[0].length).toBeLessThan(long.length);
    expect(activity[0].endsWith('…')).toBe(true);
  });
});
