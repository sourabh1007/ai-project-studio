import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachTerminalWs } from './terminal-ws-server.js';
import { createTerminalManager } from './terminal-manager.js';
import { terminalDefaults } from './config.js';
import type { ServerMessage } from './terminal-protocol.js';
import type { Session } from '../session/session-contract.js';
import { createEventBus } from '../kernel/event-bus.js';
import { createClock } from '../kernel/clock.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import type { SessionEventMap } from '../session/session-launcher.js';
import type { PtyProcess } from './pty-contract.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(compose = async () => '', recovery = false) {
  const processes: Array<{
    writes: string[]; resizes: number[][]; killed: boolean;
    output(data: string): void; exit(code: number): void;
  }> = [];
  const providers = createProviderRegistry();
  providers.register({
    id: 'fixture', listModels: async () => [], startSession: () => { throw new Error('unused'); },
    buildInteractiveCommand: () => ({ command: 'fixture', args: [], env: {} }),
  });
  const bus = createEventBus<SessionEventMap>();
  const manager = createTerminalManager({
    logger: { error: () => {} },
    spawner: {
      spawn: () => {
        let output!: (data: string) => void;
        let exit!: (code: number | null) => void;
        const process = {
          writes: [] as string[], resizes: [] as number[][], killed: false,
          output: (data: string) => output(data), exit: (code: number) => exit(code),
        };
        processes.push(process);
        const pty: PtyProcess = {
          write: (data) => process.writes.push(data),
          resize: (cols, rows) => process.resizes.push([cols, rows]),
          onData: (fn) => { output = fn; }, onExit: (fn) => { exit = fn; },
          kill: () => { process.killed = true; exit(1); },
        };
        return pty;
      },
    },
    providers, bus, clock: createClock(() => 0),
    config: { ...terminalDefaults, autoRetryEnabled: false, instructionSeedSubmitDelayMs: 1, instructionSeedSubmitMaxWaitMs: 20 },
    transcriptStore: { save: async () => {}, load: async () => null, delete: async () => {} },
    bootstrap: { composeForSession: compose }, sessionFiles: { record: () => {} }, home: 'fixture',
    isTransientFailure: (line) => line.includes('TRANSIENT'),
    selfRecovery: { enabled: recovery, useMetaAnalysis: false, report: () => {} },
  });
  const session: Session = {
    id: 's1', featureId: 'f1', name: null, provider: 'fixture', requestedModel: 'auto', resolvedModel: null,
    status: 'created', kind: 'dev', prompt: '', usageFilePath: 'fixture.jsonl',
    createdAt: '', startedAt: null, endedAt: null, exitCode: null,
  };
  const server = createServer();
  const wss = attachTerminalWs({
    server, manager, config: terminalDefaults,
    getSession: (id) => id === session.id ? session : null,
    resolveCwd: () => 'fixture', logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    manager.shutdown();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${terminalDefaults.wsPath}`;
  function connect(id = 's1', origin?: string) {
    const ws = new WebSocket(`${url}?sessionId=${id}`, origin ? { origin } : {});
    const frames: ServerMessage[] = [];
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    let seq = 0;
    return {
      ws, frames, closed,
      input: (data: string, generation = 1) => ws.send(JSON.stringify({ type: 'input', data, generation, seq: ++seq })),
      resize: (cols: number, rows: number, generation = 1) => ws.send(JSON.stringify({ type: 'resize', cols, rows, generation })),
      ready: async (generation = 1) => {
        await expect.poll(() => frames.some((frame) => frame.type === 'state' && frame.state === 'ready' && frame.generation === generation)).toBe(true);
      },
    };
  }
  return { manager, session, processes, connect, bus };
}

describe('terminal WebSocket lifecycle (real WS, controlled PTY port)', () => {
  it('rejects unknown sessions and cross-origin sockets', async () => {
    const f = await fixture();
    expect(await f.connect('missing').closed).toBe(4404);
    expect(await f.connect('s1', 'https://evil.example').closed).toBe(4403);
    expect(f.processes).toHaveLength(0);
  });
  it('surfaces failed launch and invalid protocol rather than silently accepting input', async () => {
    const f = await fixture(async () => { throw new Error('compose failed'); });
    const c = f.connect();
    await expect.poll(() => c.frames.some((m) => m.type === 'state' && m.state === 'failed')).toBe(true);
    c.ws.send('invalid');
    expect(await c.closed).toBe(4400);
  });
  it('delayed launch preserves FIRST then SECOND once, latest initial resize, and output replay', async () => {
    const gate = deferred<string>();
    const f = await fixture(() => gate.promise);
    const c = f.connect();
    await new Promise<void>((resolve) => c.ws.once('open', resolve));
    c.input('FIRST', 0);
    c.input('SECOND', 0);
    c.resize(80, 24, 0);
    c.resize(132, 43, 0);
    // Ping/pong is a transport barrier: all prior frames reached the registered handler.
    const barrier = new Promise<void>((resolve) => c.ws.once('pong', () => resolve()));
    c.ws.ping(); await barrier;
    gate.resolve('');
    await c.ready();
    expect(f.processes).toHaveLength(1);
    expect(f.processes[0].writes).toEqual(['FIRST', 'SECOND']);
    expect(f.processes[0].resizes).toEqual([[132, 43]]);
    expect(c.frames.filter((m) => m.type === 'ack').map((m) => m.outcome)).toEqual(['written', 'written']);
    f.processes[0].output('SCROLLBACK');
    const second = f.connect();
    await second.ready();
    expect(second.frames).toContainEqual({ type: 'output', data: 'SCROLLBACK' });
    f.processes[0].output('LIVE');
    await expect.poll(() => c.frames).toContainEqual({ type: 'output', data: 'LIVE' });
    await expect.poll(() => second.frames).toContainEqual({ type: 'output', data: 'LIVE' });
    c.input('NEXT');
    await expect.poll(() => f.processes[0].writes).toEqual(['FIRST', 'SECOND', 'NEXT']);
  });
  it('deduplicates parallel launches and cancels pending delete/shutdown without resurrection', async () => {
    for (const action of ['none', 'close', 'shutdown'] as const) {
      const gate = deferred<string>();
      const f = await fixture(() => gate.promise);
      const a = f.manager.getOrLaunch(f.session);
      const b = f.manager.getOrLaunch(f.session);
      const outcome = Promise.allSettled([a, b]);
      if (action === 'close') f.manager.close('s1');
      if (action === 'shutdown') f.manager.shutdown();
      gate.resolve('');
      const results = await outcome;
      if (action === 'none') {
        expect(results[0]).toEqual(results[1]);
        expect(f.processes).toHaveLength(1);
      } else {
        expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
        expect(f.processes).toHaveLength(0);
        expect(f.manager.get('s1')).toBeUndefined();
      }
    }
  });
  it('preserves normal bootstrap context before submitting queued user input', async () => {
    const f = await fixture(async () => 'BOOTSTRAP');
    const c = f.connect();
    await expect.poll(() => c.frames.some((m) => m.type === 'state' && m.state === 'bootstrapping')).toBe(true);
    c.input('USER\r');
    const barrier = new Promise<void>((resolve) => c.ws.once('pong', () => resolve()));
    c.ws.ping(); await barrier;
    expect(f.processes[0].writes).toEqual([]);
    f.processes[0].output('? help');
    await c.ready();
    expect(f.processes[0].writes).toEqual(['BOOTSTRAP', '\r', 'USER\r']);
    expect(c.frames.filter((m) => m.type === 'ack').map((m) => m.outcome)).toEqual(['written']);
  });
  it('does not attach a sink when the socket disconnects during launch', async () => {
    const gate = deferred<string>();
    const f = await fixture(() => gate.promise);
    const subscribe = f.manager.onTerminal.bind(f.manager);
    const unsubscribed = vi.fn();
    vi.spyOn(f.manager, 'onTerminal').mockImplementation((id, listener) => {
      const detach = subscribe(id, listener);
      return () => { detach(); unsubscribed(); };
    });
    const c = f.connect();
    await new Promise<void>((resolve) => c.ws.once('open', resolve));
    c.input('discarded', 0);
    c.ws.close(); await c.closed;
    await expect.poll(() => unsubscribed).toHaveBeenCalledOnce();
    gate.resolve('');
    await expect.poll(() => f.manager.get('s1')).toBeDefined();
    f.manager.get('s1')!.notify('no socket should receive this');
    expect(f.processes[0].writes).toEqual([]);
    expect(unsubscribed).toHaveBeenCalledOnce();
  });
  it('rebinds the current real socket on automatic recovery and rejects the old epoch', async () => {
    const f = await fixture(async () => '', true);
    const c = f.connect(); await c.ready();
    c.input('PROMPT\r');
    await expect.poll(() => f.processes[0].writes).toEqual(['PROMPT\r']);
    f.manager.confirmReplaySafeRequest('s1', 'PROMPT');
    const old = f.processes[0];
    old.output('TRANSIENT\n');
    await expect.poll(() => f.processes).toHaveLength(2);
    f.processes[1].output('? help');
    await c.ready(2);
    expect(f.processes[1].writes).toEqual(['PROMPT', '\r']);
    expect(old.killed).toBe(true);
    old.exit(9);
    expect(f.manager.get('s1')?.generation).toBe(2);
    f.processes[1].output('REPLACEMENT');
    await expect.poll(() => c.frames).toContainEqual({ type: 'output', data: 'REPLACEMENT' });
    c.input('STALE', 1);
    c.resize(1, 1, 1);
    c.input('CURRENT', 2);
    c.resize(100, 30, 2);
    await expect.poll(() => f.processes[1].writes).toEqual(['PROMPT', '\r', 'CURRENT']);
    await expect.poll(() => f.processes[1].resizes).toEqual([[100, 30]]);
    expect(c.frames.some((m) => m.type === 'ack' && m.outcome === 'rejected')).toBe(true);
    f.processes[1].exit(0);
    await expect.poll(() => c.frames).toContainEqual({ type: 'exit', code: 0 });
  });
  it('rejects the entire queued input and subsequent Enter after overflow', async () => {
    const gate = deferred<string>();
    const f = await fixture(() => gate.promise);
    const c = f.connect();
    await new Promise<void>((resolve) => c.ws.once('open', resolve));
    c.input('PREFIX', 0);
    c.input('x'.repeat(terminalDefaults.bootstrapInputBufferBytes + 1), 0);
    c.input('\r', 0);
    await expect.poll(() => c.frames.filter((m) => m.type === 'ack')).toHaveLength(3);
    gate.resolve('');
    await expect.poll(() => f.processes).toHaveLength(1);
    expect(f.processes[0].writes).toEqual([]);
    expect(c.frames.filter((m) => m.type === 'ack').every((m) => m.outcome === 'rejected')).toBe(true);
    expect(c.frames.some((m) => m.type === 'state' && m.state === 'failed')).toBe(true);
  });
  it('cancels recovery from real socket input while the replacement is bootstrapping', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const f = await fixture(() => ++calls === 1 ? Promise.resolve('') : gate.promise, true);
    const c = f.connect(); await c.ready();
    f.manager.confirmReplaySafeRequest('s1', 'PROMPT');
    f.processes[0].output('TRANSIENT\n');
    await expect.poll(() => calls).toBe(2);
    c.input('\x03');
    await expect.poll(() => c.frames.some((m) => m.type === 'ack' && m.outcome === 'rejected')).toBe(true);
    gate.resolve('');
    await expect.poll(() => c.frames.some((m) => m.type === 'state' && m.state === 'failed')).toBe(true);
    expect(f.processes).toHaveLength(1);
    expect(f.manager.get('s1')).toBeUndefined();
  });
  it('cannot resurrect a pending recovery after delete or shutdown and reports failure on the existing socket', async () => {
    for (const action of ['close', 'shutdown'] as const) {
      const gate = deferred<string>();
      let calls = 0;
      const f = await fixture(() => ++calls === 1 ? Promise.resolve('') : gate.promise, true);
      const c = f.connect(); await c.ready();
      c.input('PROMPT\r');
      await expect.poll(() => f.processes[0].writes).toEqual(['PROMPT\r']);
      f.manager.confirmReplaySafeRequest('s1', 'PROMPT');
      f.processes[0].output('TRANSIENT\n');
      await expect.poll(() => calls).toBe(2);
      if (action === 'close') f.manager.close('s1');
      else f.manager.shutdown();
      gate.resolve('');
      await expect.poll(() => c.frames.some((m) => m.type === 'state' && m.state === 'failed')).toBe(true);
      expect(f.processes).toHaveLength(1);
      expect(f.processes[0].killed).toBe(true);
      expect(f.manager.get('s1')).toBeUndefined();
    }
  });
});
