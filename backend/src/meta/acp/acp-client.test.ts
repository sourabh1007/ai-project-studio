import { describe, it, expect, vi } from 'vitest';
import {
  AcpClient,
  AcpRequestError,
  type AcpProcess,
} from './acp-client.js';

interface WrittenRequest {
  id?: number;
  method: string;
  params: Record<string, unknown>;
}

class FakeProcess implements AcpProcess {
  written: WrittenRequest[] = [];
  killed = 0;
  diagnosticText: string | null = null;
  throwOnMethod: string | null = null;
  throwOnKill = false;
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;

  write(line: string): void {
    const parsed = JSON.parse(line) as WrittenRequest;
    if (parsed.method === this.throwOnMethod) {
      throw new Error(`write failed for ${parsed.method}`);
    }
    this.written.push(parsed);
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }
  onExit(handler: (code: number | null) => void): void {
    this.exitHandler = handler;
  }
  diagnostic(): string | null {
    return this.diagnosticText;
  }
  kill(): void {
    if (this.throwOnKill) {
      throw new Error('kill failed');
    }
    this.killed += 1;
  }

  emit(message: unknown): void {
    this.lineHandler?.(JSON.stringify(message));
  }
  emitRaw(line: string): void {
    this.lineHandler?.(line);
  }
  exit(code: number | null = 0): void {
    this.exitHandler?.(code);
  }

  last(method: string): WrittenRequest {
    const found = [...this.written].reverse().find((r) => r.method === method);
    if (!found) {
      throw new Error(`no ${method} request written`);
    }
    return found;
  }
  respond(method: string, result: Record<string, unknown> | null): void {
    this.emit({ jsonrpc: '2.0', id: this.last(method).id, result });
  }
  respondError(method: string, code: number, message: string): void {
    this.emit({ jsonrpc: '2.0', id: this.last(method).id, error: { code, message } });
  }
  update(sessionId: string, update: Record<string, unknown>): void {
    this.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }
}

const config = { initializeTimeoutMs: 1000, turnTimeoutMs: 1000, cancelGraceMs: 25 };
const flush = () => new Promise((r) => setImmediate(r));
const tick = () => Promise.resolve();

describe('AcpClient', () => {
  it('performs the initialize handshake', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.initialize();
    await flush();
    expect(fake.last('initialize').params).toMatchObject({ protocolVersion: 1 });
    fake.respond('initialize', { agentInfo: { name: 'Copilot' } });
    await expect(p).resolves.toBeUndefined();
    expect(client.alive).toBe(true);
  });

  it('creates a session and returns the raw result with the model catalog', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.newSession('C:\\repo');
    await flush();
    expect(fake.last('session/new').params).toEqual({
      cwd: 'C:\\repo',
      mcpServers: [],
    });
    fake.respond('session/new', {
      sessionId: 's1',
      models: { availableModels: [{ modelId: 'gpt-5.4' }] },
    });
    await expect(p).resolves.toEqual({
      sessionId: 's1',
      models: { availableModels: [{ modelId: 'gpt-5.4' }] },
    });
  });

  it('runs a turn: new session, streamed text, stop reason and usage', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const chunks: string[] = [];
    const p = client.runTurn({
      prompt: 'do it',
      cwd: 'C:\\repo',
      onActivity: (t) => chunks.push(t),
    });
    await flush();
    expect(fake.last('session/new').params).toEqual({ cwd: 'C:\\repo', mcpServers: [] });
    fake.respond('session/new', { sessionId: 's1' });
    await flush();
    expect(fake.last('session/prompt').params).toEqual({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'do it' }],
    });
    // Streamed updates + an unrelated update kind + a stray notification.
    fake.update('other', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'NOPE' },
    });
    fake.update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WA' } });
    fake.update('s1', { sessionUpdate: 'usage_update', used: 1 });
    fake.update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RM' } });
    fake.emit({ method: 'other/notification', params: {} });
    fake.respond('session/prompt', {
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const result = await p;
    expect(result).toEqual({
      text: 'WARM',
      sessionId: 's1',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(chunks).toEqual(['WA', 'RM']);
  });

  it('accumulates text even without an onActivity callback and tolerates missing usage', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respond('session/new', { sessionId: 's2' });
    await flush();
    fake.update('s2', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
    fake.respond('session/prompt', { stopReason: 'end_turn', usage: { inputTokens: 'x', outputTokens: 2 } });
    const result = await p;
    expect(result.text).toBe('hi');
    expect(result.usage).toBeNull();
    expect(result.stopReason).toBe('end_turn');
  });

  it('returns null usage when the prompt result omits usage', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respond('session/new', { sessionId: 's3' });
    await flush();
    fake.respond('session/prompt', { stopReason: 'end_turn' });
    const result = await p;
    expect(result.usage).toBeNull();
    expect(result.text).toBe('');
  });

  it('throws when session/new returns no session id', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respond('session/new', { notASession: true });
    await expect(p).rejects.toThrow('no session id');
    expect(client.reusable).toBe(false);
    expect(fake.killed).toBe(1);
  });

  it('rejects on an error response', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respondError('session/new', -32000, 'nope');
    let error: unknown;
    try {
      await p;
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(AcpRequestError);
    const acpError = error as AcpRequestError;
    expect(acpError.message).toContain('ACP error -32000: nope');
    expect(acpError.allowFallbackToCold).toBe(true);
    expect(fake.killed).toBe(1);
  });

  it('rejects a prompt error as ambiguous dispatched work and disposes the client', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const turn = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respond('session/new', { sessionId: 's4' });
    await flush();
    fake.respondError('session/prompt', -32001, 'prompt failed');
    let error: unknown;
    try {
      await turn;
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(AcpRequestError);
    const acpError = error as AcpRequestError;
    expect(acpError.allowFallbackToCold).toBe(false);
    expect(fake.last('session/cancel').params).toEqual({ sessionId: 's4' });
  });

  it('disposes on a prompt error even when the active turn ownership has already moved on', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const turn = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respond('session/new', { sessionId: 's4' });
    await flush();
    (
      client as unknown as {
        active: { requestId: number | null };
      }
    ).active.requestId = 999;
    fake.respondError('session/prompt', -32001, 'prompt failed');
    await expect(turn).rejects.toThrow('ACP error -32001: prompt failed');
    expect(fake.last('session/cancel').params).toEqual({ sessionId: 's4' });
  });

  it('ignores unparseable lines and responses to unknown ids', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.initialize();
    await flush();
    fake.emitRaw('not json at all');
    fake.emit({ id: 9999, result: {} });
    fake.respond('initialize', {});
    await expect(p).resolves.toBeUndefined();
  });

  it('fails fast when the process never speaks the protocol, reporting what it said instead', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.initialize();
    await flush();
    // A CLI that prints a banner or an auth prompt instead of ACP would
    // otherwise hang for the full timeout and report nothing actionable.
    for (const line of [
      'Welcome to Copilot CLI',
      'You are not signed in.',
      '  ', // blank noise must not count toward the failure threshold
      'Run `gh auth login` to continue.',
      'Press any key...',
      'Error: not authenticated',
    ]) {
      fake.emitRaw(line);
    }
    const error = await p.catch((e: unknown) => e as AcpRequestError);
    expect(error).toBeInstanceOf(AcpRequestError);
    expect(error.message).toContain('did not speak the protocol');
    expect(error.message).toContain('not authenticated');
    // The prompt is fine, this process is not — a cold retry is allowed.
    expect(error.allowFallbackToCold).toBe(true);
    expect(client.reusable).toBe(false);
    expect(fake.killed).toBe(1);
  });

  it('bounds retained non-protocol output and never truncates mid-report', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.initialize();
    await flush();
    for (let i = 0; i < 20; i++) fake.emitRaw(`noise-${i} ${'x'.repeat(500)}`);
    const error = await p.catch((e: unknown) => e as AcpRequestError);
    // It fails at the threshold, so the retained tail is the earliest output —
    // the banner or error that explains the failure — and nothing after it.
    expect(error.message).toContain('noise-0');
    expect(error.message).not.toContain('noise-5');
    // Each line is clipped and the whole report stays bounded.
    expect(error.message.length).toBeLessThan(1400);
  });

  it('treats output after a valid message as diagnostics rather than a protocol failure', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 50,
        cancelGraceMs: 10,
      });
      const handshake = client.initialize();
      fake.respond('initialize', {});
      await handshake;
      const turn = client.newSession('C:\\repo');
      // The process has proven it speaks ACP, so chatter must not fail it early.
      for (let i = 0; i < 20; i++) fake.emitRaw(`warning: retrying upstream ${i}`);
      expect(client.reusable).toBe(true);
      const settled = turn.catch((e: unknown) => e as AcpRequestError);
      await vi.advanceTimersByTimeAsync(60);
      const error = await settled;
      // ...but it is still reported, so the timeout is explainable.
      expect(error.message).toContain('timed out after 50ms');
      expect(error.message).toContain('warning: retrying upstream 19');
    } finally {
      vi.useRealTimers();
    }
  });

  it('combines stderr diagnostics with unexpected stdout', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      fake.diagnosticText = 'stderr: ENOENT';
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 50,
        cancelGraceMs: 10,
      });
      const p = client.initialize();
      fake.emitRaw('plain stdout line');
      const settled = p.catch((e: unknown) => e as AcpRequestError);
      await vi.advanceTimersByTimeAsync(60);
      const error = await settled;
      expect(error.message).toContain('stderr: ENOENT');
      expect(error.message).toContain('unexpected output: plain stdout line');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when a request cannot be written to the process', async () => {
    const fake = new FakeProcess();
    fake.throwOnMethod = 'initialize';
    const client = new AcpClient(fake, config);
    await expect(client.initialize()).rejects.toThrow(
      'ACP initialize could not be written',
    );
    expect(fake.killed).toBe(1);
  });

  it('times out a request that never gets a response', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 50,
        cancelGraceMs: 10,
      });
      const p = client.initialize();
      const assertion = expect(p).rejects.toThrow('ACP initialize timed out after 50ms');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(client.reusable).toBe(false);
      expect(fake.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out session/new and disposes the client before any prompt is sent', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 100,
        turnTimeoutMs: 50,
        cancelGraceMs: 10,
      });
      const session = client.newSession('C:\\repo');
      const assertion = expect(session).rejects.toThrow(
        'ACP session/new timed out after 50ms',
      );
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(fake.killed).toBe(1);
      expect(client.reusable).toBe(false);
      expect(fake.written.some((entry) => entry.method === 'session/prompt')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes the client when runTurn times out before session/new responds', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 100,
        turnTimeoutMs: 50,
        cancelGraceMs: 10,
      });
      const turn = client.runTurn({ prompt: 'hello' });
      turn.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(60);
      await expect(turn).rejects.toThrow('ACP session/new timed out after 50ms');
      expect(fake.killed).toBe(1);
      expect(client.reusable).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a prompt, sends session/cancel, and kills after cancellation is acknowledged', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 50,
        cancelGraceMs: 25,
      });
      const turn = client.runTurn({ prompt: 'A' });
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      const assertion = expect(turn).rejects.toThrow('ACP session/prompt timed out after 50ms');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(client.reusable).toBe(false);
      expect(fake.last('session/cancel').params).toEqual({ sessionId: 'A' });
      fake.update('A', { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
      expect(fake.killed).toBe(1);
      // Late output for the cancelled session is ignored because the turn no longer owns it.
      fake.update('A', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one absolute deadline across session/new and session/prompt', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 100,
        cancelGraceMs: 25,
      });
      const turn = client.runTurn({
        prompt: 'A',
        deadlineAt: Date.now() + 50,
      });
      await tick();
      await vi.advanceTimersByTimeAsync(40);
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 10ms',
      );
      await vi.advanceTimersByTimeAsync(11);
      await assertion;
      expect(fake.last('session/cancel').params).toEqual({ sessionId: 'A' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('also treats an idle state update without stopReason as cancellation acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 50,
        cancelGraceMs: 25,
      });
      const turn = client.runTurn({ prompt: 'A' });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 50ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      fake.update('A', { sessionUpdate: 'state_update', state: 'idle' });
      expect(fake.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills a timed-out prompt when its late response finally arrives', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 50,
        cancelGraceMs: 25,
      });
      const turn = client.runTurn({ prompt: 'A' });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 50ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(fake.killed).toBe(0);
      fake.respond('session/prompt', { stopReason: 'cancelled' });
      expect(fake.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores late activity updates once disposal for the active turn is in flight', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const chunks: string[] = [];
    const turn = client.runTurn({ prompt: 'x', onActivity: (text) => chunks.push(text) });
    await flush();
    fake.respond('session/new', { sessionId: 's5' });
    await flush();
    (
      client as unknown as {
        disposal: {
          generation: number;
          sessionId: string;
          requestId: number | null;
          timer: ReturnType<typeof setTimeout> | null;
        };
      }
    ).disposal = {
      generation: 1,
      sessionId: 's5',
      requestId: fake.last('session/prompt').id ?? null,
      timer: null,
    };
    fake.update('s5', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'late' },
    });
    fake.respond('session/prompt', { stopReason: 'cancelled' });
    await expect(turn).resolves.toMatchObject({ text: '', stopReason: 'cancelled' });
    expect(chunks).toEqual([]);
  });

  it('keeps suppressing activity after cancel grace expires and disposal bookkeeping clears', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 20,
        cancelGraceMs: 5,
      });
      const chunks: string[] = [];
      const turn = client.runTurn({ prompt: 'x', onActivity: (text) => chunks.push(text) });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 20ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 's5' });
      await tick();
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      await vi.advanceTimersByTimeAsync(5);
      fake.update('s5', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late' },
      });
      expect(chunks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps suppressing activity when kill fails and termination remains unconfirmed', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      fake.throwOnKill = true;
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 20,
        cancelGraceMs: 5,
      });
      const chunks: string[] = [];
      const turn = client.runTurn({ prompt: 'x', onActivity: (text) => chunks.push(text) });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 20ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 's5' });
      await tick();
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      await vi.advanceTimersByTimeAsync(5);
      fake.update('s5', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late' },
      });
      expect(chunks).toEqual([]);
      expect(fake.killed).toBe(0);
      expect(client.alive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an injected disposal when the matching prompt response arrives', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const turn = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respond('session/new', { sessionId: 's5' });
    await flush();
    (
      client as unknown as {
        disposal: {
          generation: number;
          sessionId: string;
          requestId: number | null;
          timer: ReturnType<typeof setTimeout> | null;
        };
      }
    ).disposal = {
      generation: 1,
      sessionId: 's5',
      requestId: fake.last('session/prompt').id ?? null,
      timer: null,
    };
    fake.respond('session/prompt', { stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ sessionId: 's5' });
    expect(fake.killed).toBe(1);
  });

  it('kills a timed-out prompt after the cancellation grace period when no acknowledgement arrives', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 50,
        cancelGraceMs: 25,
      });
      const turn = client.runTurn({ prompt: 'A' });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 50ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(fake.killed).toBe(0);
      await vi.advanceTimersByTimeAsync(30);
      expect(fake.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects new work once a timed-out client has been quarantined', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 100,
        turnTimeoutMs: 20,
        cancelGraceMs: 5,
      });
      const first = client.runTurn({ prompt: 'A' });
      const assertion = expect(first).rejects.toThrow(
        'ACP session/prompt timed out after 20ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      await expect(client.runTurn({ prompt: 'B' })).rejects.toThrow(
        'ACP client is not reusable',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a hard kill when sending session/cancel throws', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      fake.throwOnMethod = 'session/cancel';
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 20,
        cancelGraceMs: 5,
      });

      const turn = client.runTurn({ prompt: 'A' });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 20ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(fake.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries native termination after both cancellation write and kill fail', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const turn = client.runTurn({ prompt: 'A' });
    const failed = expect(turn).rejects.toThrow('exited');
    await tick();
    fake.respond('session/new', { sessionId: 'A' });
    await tick();
    fake.throwOnMethod = 'session/cancel';
    fake.throwOnKill = true;
    const kill = vi.spyOn(fake, 'kill');
    expect(() => client.dispose()).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(client.alive).toBe(true);
    fake.throwOnKill = false;
    client.dispose();
    expect(kill).toHaveBeenCalledTimes(2);
    expect(client.alive).toBe(true);
    expect(client.reusable).toBe(false);
    fake.exit();
    await failed;
    client.dispose();
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('rejects pending requests and fires exit handlers on process exit', async () => {
    const fake = new FakeProcess();
    fake.diagnosticText = 'token=secret123';
    const client = new AcpClient(fake, config);
    let exited = 0;
    client.onExit(() => {
      exited += 1;
    });
    const p = client.initialize();
    await flush();
    fake.exit(1);
    await expect(p).rejects.toThrow('ACP process exited (exit code 1): token=secret123');
    expect(exited).toBe(1);
    expect(client.alive).toBe(false);
    // A second exit is ignored.
    fake.exit(1);
    expect(exited).toBe(1);
  });

  it('reports a null exit code without appending an exit-code suffix', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.initialize();
    await flush();
    fake.exit(null);
    await expect(p).rejects.toThrow(/^ACP process exited$/);
  });

  it('no-ops dispose once the client is already dead', () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    fake.exit(0);
    client.dispose();
    expect(fake.killed).toBe(0);
  });

  it('treats disposal or dead state as non-reusable even if the reusable flag stayed true', () => {
    const client = new AcpClient(new FakeProcess(), config);
    const mutable = client as unknown as {
      disposal: {
        generation: number;
        sessionId: string;
        requestId: number | null;
        timer: ReturnType<typeof setTimeout> | null;
      } | null;
      dead: Error | null;
    };
    mutable.disposal = {
      generation: 1,
      sessionId: 's',
      requestId: 1,
      timer: null,
    };
    expect(client.reusable).toBe(false);
    mutable.disposal = null;
    mutable.dead = new Error('dead');
    expect(client.reusable).toBe(false);
  });

  it('no-ops dispose once cancellation is already in flight', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const turn = client.runTurn({ prompt: 'x' });
    await flush();
    fake.respond('session/new', { sessionId: 's6' });
    await flush();
    client.dispose();
    expect(client.reusable).toBe(false);
    client.dispose();
    fake.respond('session/prompt', { stopReason: 'cancelled' });
    await expect(turn).resolves.toMatchObject({ sessionId: 's6' });
    expect(fake.written.filter((entry) => entry.method === 'session/cancel')).toHaveLength(1);
    expect(fake.killed).toBe(1);
  });

  it('uses the default cancellation grace when none is configured', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 20,
      });
      const turn = client.runTurn({ prompt: 'A' });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 20ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      await vi.advanceTimersByTimeAsync(994);
      expect(fake.killed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a pending disposal when the process exits before cancel acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, {
        initializeTimeoutMs: 50,
        turnTimeoutMs: 20,
        cancelGraceMs: 30,
      });
      const turn = client.runTurn({ prompt: 'A' });
      const assertion = expect(turn).rejects.toThrow(
        'ACP session/prompt timed out after 20ms',
      );
      await tick();
      fake.respond('session/new', { sessionId: 'A' });
      await tick();
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      fake.exit(9);
      await vi.advanceTimersByTimeAsync(40);
      expect(fake.killed).toBe(0);
      expect(client.alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects new requests once the process is dead', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    fake.exit(0);
    await expect(client.initialize()).rejects.toThrow('ACP process exited');
  });

  it('forwards kill to the process', () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    client.kill();
    expect(fake.killed).toBe(1);
  });

  it('lets internal disposal helpers no-op safely once already settled', () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    (client as unknown as { finishDisposal(): void }).finishDisposal();
    (client as unknown as { disposeTurn(turn: unknown): void }).disposeTurn({
      generation: 1,
      sessionId: 's',
      requestId: 1,
      text: '',
    });
    expect(fake.last('session/cancel').params).toEqual({ sessionId: 's' });
    (client as unknown as { disposeTurn(turn: unknown): void }).disposeTurn({
      generation: 1,
      sessionId: 's',
      requestId: 1,
      text: '',
    });
  });
});
