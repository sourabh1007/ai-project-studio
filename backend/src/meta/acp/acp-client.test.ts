import { describe, it, expect, vi } from 'vitest';
import { AcpClient, type AcpProcess } from './acp-client.js';

interface WrittenRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

class FakeProcess implements AcpProcess {
  written: WrittenRequest[] = [];
  killed = 0;
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;

  write(line: string): void {
    this.written.push(JSON.parse(line));
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }
  onExit(handler: (code: number | null) => void): void {
    this.exitHandler = handler;
  }
  kill(): void {
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
}

const config = { initializeTimeoutMs: 1000, turnTimeoutMs: 1000 };
const flush = () => new Promise((r) => setImmediate(r));

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
    fake.emit({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WA' } } },
    });
    fake.emit({
      method: 'session/update',
      params: { update: { sessionUpdate: 'usage_update', used: 1 } },
    });
    fake.emit({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RM' } } },
    });
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
    fake.emit({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
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
  });

  it('rejects on an error response', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    const p = client.runTurn({ prompt: 'x' });
    await flush();
    fake.emit({ id: fake.last('session/new').id, error: { code: -32000, message: 'nope' } });
    await expect(p).rejects.toThrow('ACP error -32000: nope');
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

  it('times out a request that never gets a response', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeProcess();
      const client = new AcpClient(fake, { initializeTimeoutMs: 50, turnTimeoutMs: 50 });
      const p = client.initialize();
      const assertion = expect(p).rejects.toThrow('ACP initialize timed out after 50ms');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects pending requests and fires exit handlers on process exit', async () => {
    const fake = new FakeProcess();
    const client = new AcpClient(fake, config);
    let exited = 0;
    client.onExit(() => {
      exited += 1;
    });
    const p = client.initialize();
    await flush();
    fake.exit(1);
    await expect(p).rejects.toThrow('ACP process exited');
    expect(exited).toBe(1);
    expect(client.alive).toBe(false);
    // A second exit is ignored.
    fake.exit(1);
    expect(exited).toBe(1);
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
});
