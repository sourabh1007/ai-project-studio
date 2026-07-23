import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attachTerminalWs } from './terminal-ws-server.js';
import { terminalDefaults } from './config.js';
import type { ClientMessage, ServerMessage } from './terminal-protocol.js';
import type { TerminalManager } from './terminal-manager.js';
import type { TerminalSession, TerminalOutputSink } from './terminal-session.js';
import type { Session } from '../session/session-contract.js';

/**
 * Integration coverage for the terminal WebSocket bridge — the transport layer
 * that connects the browser xterm terminal to the PTY. It is excluded from unit
 * coverage as an IO adapter, but is exactly where "the terminal won't open"
 * shows up, so this drives a real ws client through the real server and asserts
 * the full handshake, output replay, input/resize forwarding, exit and the
 * unknown-session / launch-failure error paths.
 */

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function sampleSession(id: string): Session {
  return {
    id,
    featureId: 'feat-1',
    provider: 'agency',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'created',
    kind: 'dev',
    prompt: '',
    usageFilePath: `/tmp/${id}.jsonl`,
    createdAt: '2020-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
}

/** A controllable fake terminal that records input and lets the test push output. */
function fakeTerminal(sessionId: string, scrollback: string) {
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  let sink: TerminalOutputSink | undefined;
  let detached = false;
  const terminal: TerminalSession = {
    sessionId,
    write: (data) => writes.push(data),
    resize: (cols, rows) => resizes.push([cols, rows]),
    attach: (s) => {
      sink = s;
      if (scrollback.length > 0) {
        s.send(scrollback);
      }
      return () => {
        detached = true;
        sink = undefined;
      };
    },
    kill: () => {},
    exited: false,
    exitCode: null,
    transcriptText: () => '',
  };
  return {
    terminal,
    writes,
    resizes,
    pushOutput: (data: string) => sink?.send(data),
    pushExit: (code: number | null) => sink?.exit(code),
    isDetached: () => detached,
  };
}

const servers: Server[] = [];

async function startServer(
  manager: TerminalManager,
  getSession: (id: string) => Session | null,
): Promise<string> {
  const server = createServer();
  servers.push(server);
  attachTerminalWs({
    server,
    manager,
    config: terminalDefaults,
    getSession,
    logger: silentLogger,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}${terminalDefaults.wsPath}`;
}

/**
 * Buffers every server frame the moment the socket exists so none are lost to
 * the gap between connection and the first read. Returns frames in order.
 */
function makeReader(ws: WebSocket) {
  const queue: ServerMessage[] = [];
  const waiters: Array<(m: ServerMessage) => void> = [];
  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      queue.push(msg);
    }
  });
  return {
    next(): Promise<ServerMessage> {
      const buffered = queue.shift();
      if (buffered) {
        return Promise.resolve(buffered);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function encodeClient(message: ClientMessage): string {
  return JSON.stringify(message);
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

describe('attachTerminalWs (integration)', () => {
  it('closes with 4404 when the session is unknown', async () => {
    const manager: TerminalManager = {
      getOrLaunch: () => {
        throw new Error('should not launch');
      },
      get: () => undefined,
      close: () => {},
    };
    const url = await startServer(manager, () => null);
    const ws = new WebSocket(`${url}?sessionId=missing`);
    const { code } = await waitClose(ws);
    expect(code).toBe(4404);
  });

  it('closes with 4500 when launching the terminal throws', async () => {
    const manager: TerminalManager = {
      getOrLaunch: () => {
        throw new Error('spawn failed');
      },
      get: () => undefined,
      close: () => {},
    };
    const url = await startServer(manager, (id) => sampleSession(id));
    const ws = new WebSocket(`${url}?sessionId=sess-1`);
    const { code } = await waitClose(ws);
    expect(code).toBe(4500);
  });

  it('sends ready, replays scrollback and streams live output', async () => {
    const fake = fakeTerminal('sess-1', 'SCROLLBACK');
    const manager: TerminalManager = {
      getOrLaunch: () => fake.terminal,
      get: () => fake.terminal,
      close: () => {},
    };
    const url = await startServer(manager, (id) => sampleSession(id));
    const ws = new WebSocket(`${url}?sessionId=sess-1`);
    const rx = makeReader(ws);

    const ready = await rx.next();
    expect(ready).toEqual({ type: 'ready', sessionId: 'sess-1' });

    const replay = await rx.next();
    expect(replay).toEqual({ type: 'output', data: 'SCROLLBACK' });

    fake.pushOutput('LIVE');
    expect(await rx.next()).toEqual({ type: 'output', data: 'LIVE' });

    ws.close();
  });

  it('forwards client input and resize to the terminal', async () => {
    const fake = fakeTerminal('sess-1', '');
    const manager: TerminalManager = {
      getOrLaunch: () => fake.terminal,
      get: () => fake.terminal,
      close: () => {},
    };
    const url = await startServer(manager, (id) => sampleSession(id));
    const ws = new WebSocket(`${url}?sessionId=sess-1`);
    const rx = makeReader(ws);
    await rx.next(); // ready

    ws.send(encodeClient({ type: 'input', data: 'ls\r' }));
    ws.send(encodeClient({ type: 'resize', cols: 132, rows: 43 }));

    await expect
      .poll(() => fake.writes.length > 0 && fake.resizes.length > 0)
      .toBe(true);
    expect(fake.writes).toContain('ls\r');
    expect(fake.resizes).toContainEqual([132, 43]);

    ws.close();
  });

  it('forwards the process exit code to the client', async () => {
    const fake = fakeTerminal('sess-1', '');
    const manager: TerminalManager = {
      getOrLaunch: () => fake.terminal,
      get: () => fake.terminal,
      close: () => {},
    };
    const url = await startServer(manager, (id) => sampleSession(id));
    const ws = new WebSocket(`${url}?sessionId=sess-1`);
    const rx = makeReader(ws);
    await rx.next(); // ready

    fake.pushExit(0);
    expect(await rx.next()).toEqual({ type: 'exit', code: 0 });

    ws.close();
  });

  it('detaches the client sink when the socket closes', async () => {
    const fake = fakeTerminal('sess-1', '');
    const manager: TerminalManager = {
      getOrLaunch: () => fake.terminal,
      get: () => fake.terminal,
      close: () => {},
    };
    const url = await startServer(manager, (id) => sampleSession(id));
    const ws = new WebSocket(`${url}?sessionId=sess-1`);
    const rx = makeReader(ws);
    await rx.next(); // ready
    ws.close();

    await expect.poll(() => fake.isDetached()).toBe(true);
  });
});
