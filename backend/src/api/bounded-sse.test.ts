import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundedSse, type SseTransport } from './bounded-sse.js';
import { sseConfigSchema, sseDefaults, SSE_NAMESPACE, type SseConfig } from './sse-config.js';

class Transport extends EventEmitter implements SseTransport {
  writableLength = 0;
  blocked = false;
  writes: string[] = [];
  end = vi.fn(() => { this.emit('close'); });
  destroy = vi.fn(() => { this.writableLength = 0; this.emit('close'); });
  write = vi.fn((frame: string) => {
    this.writes.push(frame);
    if (this.blocked) this.writableLength += Buffer.byteLength(frame);
    return !this.blocked;
  });
  drain() { this.writableLength = 0; this.emit('drain'); }
}

function setup(patch: Partial<SseConfig> = {}) {
  const warn = vi.fn();
  const manager = createBoundedSse({ config: { ...sseDefaults, ...patch }, logger: { warn } });
  const transport = new Transport();
  const close = vi.fn();
  const connection = manager.open(transport, close)!;
  return { manager, transport, close, connection, warn };
}

afterEach(() => { vi.useRealTimers(); });

describe('bounded SSE', () => {
  it('delivers queued frames in order through real HTTP drain and end events', async () => {
    const manager = createBoundedSse({ config: sseDefaults, logger: { warn: vi.fn() } });
    const values = ['a', 'b', 'c'].map((value) => value.repeat(64 * 1024));
    const server = createServer((_request, response) => {
      const stream = manager.open(response, () => {})!;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const value of values) stream.send('chunk', value);
      stream.end();
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
      const body = await new Promise<string>((resolve, reject) => {
        get(`http://127.0.0.1:${address.port}`, (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { text += chunk; });
          response.on('error', reject);
          response.on('end', () => resolve(text));
        }).on('error', reject);
      });
      expect(body).toBe(values.map((value) => `event: chunk\ndata: ${JSON.stringify(value)}\n\n`).join(''));
      expect(manager.stats()).toEqual({ connections: 0, bufferedBytes: 0 });
    } finally {
      manager.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('validates consistent bounded configuration', () => {
    expect(SSE_NAMESPACE).toBe('sse');
    expect(sseConfigSchema.parse(sseDefaults)).toEqual(sseDefaults);
    expect(() => sseConfigSchema.parse({ ...sseDefaults, maxFrameBytes: sseDefaults.maxConnectionBytes + 1 })).toThrow('frame limit');
    expect(() => sseConfigSchema.parse({ ...sseDefaults, maxTotalBytes: 1 })).toThrow('connection limit');
    expect(() => sseConfigSchema.parse({ ...sseDefaults, maxConnections: 0 })).toThrow();
  });

  it('writes whole named/data-only frames and comments, then releases listeners on close', () => {
    const { manager, transport, connection, close } = setup();
    connection.comment('connected');
    connection.send('usage.recorded', { credits: 2 });
    connection.send(null, { kind: 'done' });
    expect(transport.writes).toEqual([
      ': connected\n\n', 'event: usage.recorded\ndata: {"credits":2}\n\n', 'data: {"kind":"done"}\n\n',
    ]);
    expect(manager.stats()).toEqual({ connections: 1, bufferedBytes: 0 });
    const cleanup = transport.listeners('close')[0];
    const drain = transport.listeners('drain')[0];
    transport.emit('close');
    cleanup(); drain();
    connection.send('ignored', {}); connection.comment('ignored'); connection.end();
    expect(close).toHaveBeenCalledOnce();
    expect(transport.eventNames()).toEqual([]);
    expect(transport.writes).toHaveLength(3);
    expect(manager.stats()).toEqual({ connections: 0, bufferedBytes: 0 });
  });

  it('queues ordered events behind backpressure and resumes through repeated drains', () => {
    const { manager, transport, connection } = setup();
    transport.blocked = true;
    connection.send(null, 1); connection.send(null, 2); connection.send(null, 3);
    expect(transport.writes).toEqual(['data: 1\n\n']);
    expect(manager.stats().bufferedBytes).toBe(27);
    transport.drain();
    expect(transport.writes).toEqual(['data: 1\n\n', 'data: 2\n\n']);
    expect(manager.stats().bufferedBytes).toBe(18);
    transport.blocked = false;
    transport.drain();
    expect(transport.writes).toEqual(['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']);
    expect(manager.stats().bufferedBytes).toBe(0);
    connection.end();
    expect(transport.end).toHaveBeenCalledOnce();
  });

  it('flushes the final frame before ending and accepts no new work while finishing', () => {
    const { manager, transport, connection } = setup();
    transport.blocked = true;
    connection.comment('first'); connection.send(null, 'done'); connection.end();
    connection.end(); connection.send(null, 'late'); connection.comment('late');
    expect(transport.end).not.toHaveBeenCalled();
    transport.blocked = false; transport.drain();
    expect(transport.writes).toEqual([': first\n\n', 'data: "done"\n\n']);
    expect(transport.end).toHaveBeenCalledOnce();
    expect(manager.stats().connections).toBe(0);
  });

  it('times out stalled clients without changing unrelated subscribers', () => {
    vi.useFakeTimers();
    const { manager, transport, connection, warn, close } = setup({ blockedTimeoutMs: 10 });
    const other = new Transport();
    const healthy = manager.open(other, vi.fn())!;
    transport.blocked = true;
    connection.send(null, 1); connection.send(null, 2);
    vi.advanceTimersByTime(10);
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'backpressure-timeout' }));
    healthy.send(null, 3);
    expect(other.writes).toEqual(['data: 3\n\n']);
    expect(manager.stats()).toEqual({ connections: 1, bufferedBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
    manager.close();
  });

  it.each([
    { maxFrameBytes: 10, maxConnectionBytes: 100, maxTotalBytes: 100 },
    { maxFrameBytes: 100, maxConnectionBytes: 100, maxTotalBytes: 100 },
  ])('enforces byte bounds including multibyte data and native buffered writes %j', (config) => {
    const { manager, transport, connection, warn } = setup(config);
    transport.blocked = true;
    for (let i = 0; i < 10000; i++) connection.send(null, '\u{1F600}'.repeat(4));
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(manager.stats()).toEqual({ connections: 0, bufferedBytes: 0 });
  });

  it('enforces the shared connection and byte budgets before native writes', () => {
    const { manager, transport, connection } = setup({
      maxConnections: 2, maxFrameBytes: 30, maxConnectionBytes: 60, maxTotalBytes: 60,
    });
    transport.blocked = true;
    connection.send(null, 'a'.repeat(20));
    const other = new Transport(); other.blocked = true;
    const second = manager.open(other, vi.fn())!;
    second.send(null, 'b'.repeat(20));
    expect(manager.open(new Transport(), vi.fn())).toBeNull();
    second.send(null, 1);
    expect(other.destroy).toHaveBeenCalledOnce();
    expect(transport.destroy).not.toHaveBeenCalled();
    expect(manager.stats().bufferedBytes).toBe(30);
    manager.close(); manager.close();
    expect(manager.open(new Transport(), vi.fn())).toBeNull();
  });

  it('surfaces transport failure once and detaches subscribers', () => {
    const { manager, transport, connection, close, warn } = setup();
    transport.write.mockImplementation(() => { throw new Error('native write failed'); });
    connection.send(null, 1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'write-failed' }));
    expect(close).toHaveBeenCalledOnce();
    expect(manager.stats().connections).toBe(0);
    const other = new Transport();
    manager.open(other, vi.fn());
    const fail = other.listeners('error')[0];
    fail(); fail();
    expect(other.destroy).toHaveBeenCalledOnce();
  });
});
