import type { Server } from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '../kernel/logger.js';
import type { Session } from '../session/session-contract.js';
import type { TerminalConfig } from './config.js';
import type { TerminalManager } from './terminal-manager.js';
import {
  decodeClientMessage,
  encodeServerMessage,
} from './terminal-protocol.js';

export interface TerminalWsDeps {
  server: Server;
  manager: TerminalManager;
  config: TerminalConfig;
  /** Resolves the persisted session a connection is asking to attach to. */
  getSession: (id: string) => Session | null;
  /** Working directory the interactive CLI runs in. */
  cwd?: string;
  logger: Logger;
}

/**
 * Bridges the browser xterm terminal to a PTY over a WebSocket. Transport-only
 * glue over the tested {@link TerminalManager} and protocol; excluded from
 * coverage like other IO adapters.
 */
export function attachTerminalWs(deps: TerminalWsDeps): WebSocketServer {
  const wss = new WebSocketServer({
    server: deps.server,
    path: deps.config.wsPath,
  });

  wss.on('connection', (socket: WebSocket, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = deps.getSession(sessionId);
    if (!session) {
      socket.close(4404, 'Unknown session');
      return;
    }

    let terminal;
    try {
      terminal = deps.manager.getOrLaunch(session, { cwd: deps.cwd });
    } catch (error) {
      deps.logger.error('Terminal launch failed', error);
      socket.close(4500, 'Launch failed');
      return;
    }

    socket.send(encodeServerMessage({ type: 'ready', sessionId }));
    const detach = terminal.attach({
      send: (data) =>
        socket.send(encodeServerMessage({ type: 'output', data })),
      exit: (code) => socket.send(encodeServerMessage({ type: 'exit', code })),
    });

    socket.on('message', (raw: { toString(): string }) => {
      const message = decodeClientMessage(raw.toString());
      if (!message) {
        return;
      }
      if (message.type === 'input') {
        terminal.write(message.data);
      } else {
        terminal.resize(message.cols, message.rows);
      }
    });

    socket.on('close', () => detach());
  });

  return wss;
}
