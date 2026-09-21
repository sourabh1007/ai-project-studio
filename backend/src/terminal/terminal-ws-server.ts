import type { Server } from 'node:http';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { URL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '../kernel/logger.js';
import type { Session } from '../session/session-contract.js';
import type { TerminalConfig } from './config.js';
import type { TerminalManager } from './terminal-manager.js';
import {
  decodeClientMessage,
  encodeServerMessage,
  type ServerMessage,
} from './terminal-protocol.js';
import { isAllowedTerminalOrigin } from './terminal-origin.js';
import { createTerminalConnection } from './terminal-connection.js';
import {
  launchWithSelfHealing,
  type HealFsPort,
  type HealLevel,
} from './terminal-launch-heal.js';

/** Real filesystem port for self-healing: existence checks + recursive mkdir. */
const nodeHealFs: HealFsPort = {
  dirExists: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return existsSync(path);
    }
  },
  ensureDir: (path) => {
    try {
      mkdirSync(path, { recursive: true });
      return true;
    } catch {
      return false;
    }
  },
};

/** Renders a self-healing status line as ANSI-coloured terminal output. */
function formatHealLine(level: HealLevel, message: string): string {
  const badge =
    level === 'success'
      ? '\x1b[32m✔\x1b[0m'
      : level === 'error'
        ? '\x1b[31m✖\x1b[0m'
        : '\x1b[36m🩹 Self-healing\x1b[0m';
  const body = level === 'error' ? `\x1b[31m${message}\x1b[0m` : message;
  return `\r\n${badge} ${body}\r\n`;
}

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
  /**
   * Optional metasession diagnosis used by self-healing when a launch failure
   * cannot be repaired automatically: given the session and the failure text,
   * returns a short human explanation of the likely cause and fix.
   */
  diagnose?: (session: Session, errorText: string) => Promise<string | null>;
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

    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(encodeServerMessage(message));
    };

    const connection = createTerminalConnection({
      launch: async () => {
        const resolvedCwd = deps.resolveCwd?.(session) ?? deps.cwd;
        const fallbackCwd = deps.cwd ?? process.cwd();
        try {
          return await launchWithSelfHealing({
            resolvedCwd,
            fallbackCwd,
            fs: nodeHealFs,
            emit: (level, message) => send({ type: 'output', data: formatHealLine(level, message) }),
            diagnose: deps.diagnose
              ? (errorText) => deps.diagnose!(session, errorText)
              : undefined,
            launch: (cwd) => deps.manager.getOrLaunch(session, { cwd }),
          });
        } catch (error) {
          deps.logger.error('Terminal launch failed', error);
          throw error;
        }
      },
      subscribe: (listener) => deps.manager.onTerminal(sessionId, listener),
      observeInput: (data) => deps.manager.observeInput(sessionId, data),
      inputLimit: deps.config.bootstrapInputBufferBytes,
      send,
    });
    socket.on('message', (raw: { toString(): string }) => {
      const message = decodeClientMessage(raw.toString());
      if (message) connection.receive(message);
      else socket.close(4400, 'Invalid terminal protocol');
    });
    socket.on('close', () => connection.close());
    void connection.start();
  });

  return wss;
}
