import { describe, expect, it, vi } from 'vitest';
import { request, createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createMobileGateway } from './mobile-gateway-adapter.js';
import { mobileDefaults } from './config.js';
import { mobileHash } from './mobile-access.js';

const origin = 'https://studio.example';
const key = 'k'.repeat(43);
const portOf = (server: Server): number => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  return address.port;
};
const call = (port: number, path: string, options: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) =>
  new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
      host: 'studio.example', 'x-forwarded-proto': 'https', origin, 'content-type': 'application/json', ...options.headers,
    } }, (res) => {
      const data: Buffer[] = [];
      res.on('data', (chunk: Buffer) => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(data).toString() }));
    });
    req.on('error', reject);
    req.end(options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)));
  });

describe('real mobile gateway transport', () => {
  it('isolates the desktop API, enforces HTTPS-origin cookies, and authenticates/revokes terminal upgrades', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-mobile-gateway-'));
    writeFileSync(join(dir, 'index.html'), '<main>Mobile fixture</main>');
    const upstream = createServer();
    const backend = new WebSocketServer({ server: upstream, path: '/api/terminal' });
    const origins: string[] = [];
    backend.on('connection', (socket, req) => {
      origins.push(req.headers.origin ?? '');
      socket.on('message', (data) => socket.send(data.toString()));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const gateway = createMobileGateway({
      config: { ...mobileDefaults, port: 0, publicOrigin: origin, accessKeyHash: mobileHash(key) },
      uiDist: dir, logger: { error: vi.fn(), info: vi.fn() },
      routes: [{ method: 'get', path: '/bootstrap', handler: () => ({ status: 200, body: { chats: [] } }) }],
      terminalTarget: () => `ws://127.0.0.1:${portOf(upstream)}/api/terminal`,
      terminalAllowed: (id) => id === 'terminal',
    });
    const sockets: WebSocket[] = [];
    try {
      await gateway.listen();
      const port = portOf(gateway.server);
      expect((await call(port, '/mobile')).status).toBe(200);
      expect((await call(port, '/api/mobile/bootstrap')).status).toBe(401);
      expect((await call(port, '/api/features')).status).toBe(404);
      const invalidHeaders: Array<Record<string, string>> = [
        { host: 'evil.example' }, { origin: 'https://evil.example' }, { 'x-forwarded-proto': 'http' }, { origin: '' },
      ];
      for (const headers of invalidHeaders) {
        expect((await call(port, '/mobile/login', { method: 'POST', body: { key }, headers })).status).toBe(403);
      }
      expect((await call(port, '/mobile/login', { method: 'POST', body: {} })).status).toBe(400);
      const malformed = await call(port, '/mobile/login', { method: 'POST', rawBody: `{"key":"${key}"` });
      expect(malformed.status).toBe(400);
      expect(malformed.body).not.toContain(key);
      expect((await call(port, '/mobile/login', { method: 'POST', body: { key: 'x'.repeat(300000) } })).status).toBe(413);
      const signedIn = await call(port, '/mobile/login', { method: 'POST', body: { key } });
      expect(signedIn.status).toBe(200);
      const rawCookie = signedIn.headers['set-cookie']![0];
      expect(rawCookie).toContain('HttpOnly');
      expect(rawCookie).toContain('Secure');
      expect(rawCookie).toContain('SameSite=Strict');
      expect(rawCookie).not.toContain(key);
      const cookie = rawCookie.split(';')[0];
      expect((await call(port, '/api/mobile/bootstrap', { headers: { cookie } })).status).toBe(200);
      const rejected = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?sessionId=terminal`, { origin, headers: { host: 'studio.example', 'x-forwarded-proto': 'https' } });
      sockets.push(rejected);
      await expect(once(rejected, 'open')).rejects.toThrow('403');
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?sessionId=terminal`, { origin, headers: { host: 'studio.example', 'x-forwarded-proto': 'https', cookie } });
      sockets.push(socket);
      await once(socket, 'open');
      const echoed = once(socket, 'message');
      socket.send('{"kind":"input","data":"hello"}');
      expect(String((await echoed)[0])).toContain('hello');
      expect(origins).toEqual(['http://127.0.0.1']);
      const closed = once(socket, 'close');
      await call(port, '/mobile/logout', { method: 'POST', headers: { cookie } });
      await closed;
      expect((await call(port, '/api/mobile/bootstrap', { headers: { cookie } })).status).toBe(401);
    } finally {
      for (const socket of sockets) socket.terminate();
      await gateway.close();
      for (const client of backend.clients) client.terminate();
      backend.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true });
    }
  });
});
