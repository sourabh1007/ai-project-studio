import { EventEmitter } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { probeMicrosoftNetwork } from './microsoft-network-probe.js';

afterEach(() => vi.useRealTimers());

vi.mock('node:net', async (load) => {
  const net = await load<typeof import('node:net')>();
  return { ...net, createConnection: vi.fn(net.createConnection) };
});

it('detects an owned reachable listener and fails closed when it is unavailable', async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const options = { host: '127.0.0.1', port: address.port, timeoutMs: 2000 };
  try {
    expect(await probeMicrosoftNetwork(options, new AbortController().signal)).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  expect(await probeMicrosoftNetwork(options, new AbortController().signal)).toBe(false);
  expect(await probeMicrosoftNetwork(options, AbortSignal.abort())).toBe(false);
});

it('bounds a slow DNS/connection and releases the socket on shutdown cancellation', async () => {
  vi.useFakeTimers();
  for (const cancel of [false, true]) {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    vi.mocked(createConnection).mockReturnValueOnce(socket as unknown as Socket);
    const controller = new AbortController();
    const pending = probeMicrosoftNetwork({
      host: 'internal.test', port: 443, timeoutMs: 10,
    }, controller.signal);
    if (cancel) controller.abort();
    else {
      const settled = vi.fn();
      void pending.then(settled);
      await vi.advanceTimersByTimeAsync(9);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await pending).toBe(false);
    socket.emit('connect');
    socket.emit('error', new Error('Late transport failure'));
    expect(socket.destroy).toHaveBeenCalledOnce();
  }
});
