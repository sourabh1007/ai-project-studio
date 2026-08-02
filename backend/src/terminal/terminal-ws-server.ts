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
import { isAllowedTerminalOrigin } from './terminal-origin.js';

export interface TerminalWsDeps {
  server: Server;
  manager: TerminalManager;
  config: TerminalConfig;
  /** Resolves the persisted session a connection is asking to attach to. */
  getSession: (id: string) => Session | null;
  /** Working directory the interactive CLI runs in. */
  cwd?: string;
  /**
   * Per-session working directory (the local checkout of the session's
   * repository). Takes precedence over {@link TerminalWsDeps.cwd} when it
   * returns a path; falls back to `cwd` for repo-less sessions.
   */
  resolveCwd?: (session: Session) => string | undefined;
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

  wss.on('connection', async (socket: WebSocket, req) => {
    // Reject cross-site browser connections: WebSockets bypass same-origin
    // policy, so a malicious page could otherwise attach to a live session and
    // inject keystrokes into the CLI. Only our own localhost origin is allowed.
    if (!isAllowedTerminalOrigin(req.headers.origin)) {
      deps.logger.error('Terminal WS rejected: bad origin', req.headers.origin);
      socket.close(4403, 'Forbidden origin');
      return;
    }

    const url = new URL(req.url ?? '', 'http://localhost');
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = deps.getSession(sessionId);
    if (!session) {
      socket.close(4404, 'Unknown session');
      return;
    }

    let terminal;
    try {
      const cwd = deps.resolveCwd?.(session) ?? deps.cwd;
      terminal = await deps.manager.getOrLaunch(session, { cwd });
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
    const bufferedInput: string[] = [];
    let bufferedInputBytes = 0;
    let connected = true;

    const writeInput = (data: string): boolean => {
      try {
        terminal.write(data);
        return true;
      } catch (error) {
        deps.logger.error('Terminal input forwarding failed', error);
        return false;
      }
    };

    const flushInput = (state: 'ready' | 'closed'): void => {
      if (state === 'ready' && connected) {
        for (const data of bufferedInput) {
          if (!writeInput(data)) {
            break;
          }
        }
      }
      bufferedInput.length = 0;
      bufferedInputBytes = 0;
    };
    const detachReadiness = terminal.onInputReadiness(flushInput);

    socket.on('message', (raw: { toString(): string }) => {
      const message = decodeClientMessage(raw.toString());
      if (!message) {
        return;
      }
      if (message.type === 'input') {
        if (terminal.inputReadiness === 'ready') {
          writeInput(message.data);
        } else if (terminal.inputReadiness === 'pending') {
          const bytes = Buffer.byteLength(message.data);
          if (
            bytes <=
            deps.config.bootstrapInputBufferBytes - bufferedInputBytes
          ) {
            bufferedInput.push(message.data);
            bufferedInputBytes += bytes;
          }
        }
      } else {
        terminal.resize(message.cols, message.rows);
      }
    });

    socket.on('close', () => {
      connected = false;
      bufferedInput.length = 0;
      bufferedInputBytes = 0;
      detachReadiness();
      detach();
    });
  });

  return wss;
}
