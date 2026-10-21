import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { Route } from '../api/http-contract.js';
import { mountRoutes } from '../api/express-adapter.js';
import { toErrorResult } from '../api/http-error-mapper.js';
import { AuthRequiredError, ValidationError } from '../kernel/error-types.js';
import type { Logger } from '../kernel/logger.js';
import type { MobileConfig } from './config.js';
import { createMobileAccess, mobileOrigin } from './mobile-access.js';

const COOKIE = '__Host-studio-mobile';
const cookieToken = (cookie = ''): string =>
  /(?:^|;)\s*__Host-studio-mobile=([A-Za-z0-9_-]{32,128})(?:;|$)/.exec(cookie)?.[1] ?? '';

export function createMobileGateway(deps: {
  config: MobileConfig;
  uiDist: string;
  routes: Route[];
  logger: Pick<Logger, 'error' | 'info'>;
  terminalTarget(): string;
  terminalAllowed(sessionId: string): boolean;
}) {
  const origin = mobileOrigin(deps.config);
  const host = new URL(origin).host;
  const access = createMobileAccess({
    config: deps.config, now: Date.now, token: () => randomBytes(32).toString('base64url'),
  });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('https:', 'wss:')}; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    });
    if (req.headers.host !== host || req.headers['x-forwarded-proto'] !== 'https' ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        (req.method !== 'GET' && req.headers.origin !== origin)) {
      res.status(403).json({ error: { message: 'Use the configured HTTPS mobile origin.' } });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/' };
  const terminals = new Map<string, { token: string; remote: WebSocket; local?: WebSocket }>();
  app.post('/mobile/login', (req, res, next) => {
    try {
      if (!req.body || typeof req.body.key !== 'string') throw new ValidationError('An access key is required.');
      const token = access.login(req.body.key);
      res.cookie(COOKIE, token, { ...cookieOptions, maxAge: deps.config.sessionTtlMs });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.post('/mobile/logout', (req, res) => {
    const token = cookieToken(req.headers.cookie);
    access.logout(token);
    for (const entry of terminals.values()) {
      if (entry.token === token) { entry.local?.terminate(); entry.remote.terminate(); }
    }
    res.clearCookie(COOKIE, cookieOptions);
    res.json({ ok: true });
  });
  const router = express.Router();
  router.use((req, _res, next) => {
    try { access.authorize(cookieToken(req.headers.cookie)); next(); }
    catch (error) { next(error); }
  });
  mountRoutes(router, deps.routes, deps.logger);
  app.use('/api/mobile', router);
  app.get('/mobile', (_req, res) => { res.sendFile(join(deps.uiDist, 'index.html')); });
  app.use(express.static(deps.uiDist, { index: false, dotfiles: 'deny', redirect: false }));
  app.use((_req, res) => { res.status(404).json({ error: { message: 'Mobile route not available.' } }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error && typeof error === 'object' && 'type' in error &&
        (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
      res.status(error.type === 'entity.too.large' ? 413 : 400)
        .json({ error: { kind: 'validation', message: 'The request body is invalid or too large.' } });
      return;
    }
    const result = toErrorResult(error);
    if (result.status >= 500) deps.logger.error('Mobile gateway request failed', { status: result.status });
    res.status(result.status).json(result.body);
  };
  app.use(errors);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (req, socket, head) => {
    let token: string;
    let sessionId: string;
    try {
      if (req.headers.host !== host || req.headers['x-forwarded-proto'] !== 'https' || req.headers.origin !== origin) {
        throw new AuthRequiredError('Forbidden mobile WebSocket origin.');
      }
      token = cookieToken(req.headers.cookie);
      access.authorize(token);
      const url = new URL(req.url ?? '', origin);
      sessionId = url.searchParams.get('sessionId') ?? '';
      if (url.pathname !== '/api/terminal' || !deps.terminalAllowed(sessionId) ||
          terminals.has(sessionId) || terminals.size >= deps.config.maxSessions) {
        throw new AuthRequiredError('Terminal not approved or already attached.');
      }
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = new URL(deps.terminalTarget());
    target.searchParams.set('sessionId', sessionId);
    const remote = new WebSocket(target, { origin: 'http://127.0.0.1', maxPayload: 1048576, handshakeTimeout: 10000 });
    const entry: { token: string; remote: WebSocket; local?: WebSocket } = { token, remote };
    terminals.set(sessionId, entry);
    const cleanup = (): void => {
      if (terminals.get(sessionId) === entry) terminals.delete(sessionId);
    };
    socket.once('close', () => { remote.terminate(); cleanup(); });
    remote.once('error', (error) => {
      deps.logger.error('Mobile terminal upstream failed', { message: error.message });
      entry.local?.close(1011, 'Host terminal unavailable');
      socket.destroy();
      cleanup();
    });
    remote.once('close', () => {
      entry.local?.close(1011, 'Host terminal disconnected');
      if (!entry.local) socket.destroy();
      cleanup();
    });
    remote.once('open', () => {
      if (!deps.terminalAllowed(sessionId)) { remote.close(); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (local) => {
        entry.local = local;
        const forward = (targetSocket: WebSocket, data: Buffer | ArrayBuffer | Buffer[], binary: boolean): void => {
          try {
            access.authorize(token);
            if (!deps.terminalAllowed(sessionId) || targetSocket.readyState !== WebSocket.OPEN ||
                targetSocket.bufferedAmount > 1048576) {
              local.close(1013, 'Terminal permission expired or transport is busy');
              remote.close();
              return;
            }
            targetSocket.send(data, { binary });
          } catch {
            local.close(4401, 'Mobile sign-in expired');
            remote.close();
          }
        };
        local.on('message', (data, binary) => forward(remote, data, binary));
        remote.on('message', (data, binary) => forward(local, data, binary));
        local.once('close', () => { remote.close(); cleanup(); });
      });
    });
  });
  return {
    listen: (): Promise<void> => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(deps.config.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        deps.logger.info(`Mobile gateway ready at ${origin}/mobile (HTTPS reverse proxy required)`);
        resolve();
      });
    }),
    close: (): Promise<void> => new Promise((resolve, reject) => {
      for (const entry of terminals.values()) { entry.local?.terminate(); entry.remote.terminate(); }
      wss.close();
      server.closeAllConnections();
      server.close((error) => { if (error) reject(error); else resolve(); });
    }),
    disconnectTerminal: (sessionId: string): void => {
      const entry = terminals.get(sessionId);
      entry?.local?.terminate();
      entry?.remote.terminate();
    },
    server,
  };
}
