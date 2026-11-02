import express from 'express';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextAttachmentBody } from './text-attachments-body.js';
import { createTextAttachmentRoutes } from './text-attachments-controller.js';
import { mountRoutes } from './express-adapter.js';
import { createTextAttachments } from '../text-attachments/text-attachments-service.js';
import { textAttachmentsDefaults } from '../text-attachments/config.js';
import type { Session } from '../session/session-contract.js';
import type { TextAttachmentStorage } from '../text-attachments/text-attachments-contract.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});
async function serve(storage: TextAttachmentStorage, maxBytes = 4194304) {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/sessions/:sessionId/text-attachments', createTextAttachmentBody(maxBytes));
  mountRoutes(app, createTextAttachmentRoutes(createTextAttachments({
    sessions: { get: (id) => id === 's1' ? { id } as Session : null },
    storage,
    reportFailure: vi.fn(),
    config: { ...textAttachmentsDefaults, fileBytes: maxBytes },
  })));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const fakeStorage = () => ({
  usage: vi.fn(async () => ({ files: 0, bytes: 0 })),
  list: vi.fn(async () => ({ items: [], files: 0, totalBytes: 0 })),
  remove: vi.fn(async (_attachmentId: string, _signal?: AbortSignal) => undefined),
  write: vi.fn(async (_sessionId: string, _bytes: Uint8Array, _signal?: AbortSignal) => ({ path: 'C:\\owned\\paste.txt', name: 'paste.txt', attachmentId: 'attachment-1' })),
});

describe('bounded text attachment transport', () => {
  it('round-trips bytes exactly without JSON escaping and supports the 4 MiB limit', async () => {
    const storage = fakeStorage();
    const base = await serve(storage);
    const content = '\ufeff' + '😀'.repeat(1048575) + 'x';
    const response = await fetch(`${base}/sessions/s1/text-attachments`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sessionId: 's1', attachmentId: 'attachment-1', bytes: 4194304 });
    expect(Buffer.from(storage.write.mock.calls[0][1]).equals(Buffer.from(content))).toBe(true);
  });

  it('rejects chunked oversize bodies before storage and does not block unrelated health requests', async () => {
    const storage = fakeStorage();
    const base = await serve(storage, 8);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/sessions/s1/text-attachments`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.write('😀');
      req.end('😀x');
    });
    expect(status).toBe(413);
    expect(storage.write).not.toHaveBeenCalled();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('keeps health responsive and rejects a parallel upload while a save is pending', async () => {
    const storage = fakeStorage();
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    storage.write.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { path: 'C:\\owned\\paste.txt', name: 'paste.txt', attachmentId: 'attachment-1' };
    });
    const base = await serve(storage);
    const first = fetch(`${base}/sessions/s1/text-attachments`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    await writing;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const second = await fetch(`${base}/sessions/s1/text-attachments`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(201);
  });

  it('propagates client cancellation to ongoing storage', async () => {
    const storage = fakeStorage();
    let started!: () => void;
    let cancelled!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    storage.write.mockImplementationOnce(async (_sessionId: string, _bytes: Uint8Array, signal?: AbortSignal) => {
      started();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => { cancelled(); reject(new Error('cancelled')); }, { once: true });
      });
    });
    const base = await serve(storage);
    const controller = new AbortController();
    const first = fetch(`${base}/sessions/s1/text-attachments`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'secret', signal: controller.signal,
    });
    await writing;
    controller.abort();
    await expect(first).rejects.toThrow();
    await aborted;
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('reports absent sessions, invalid UTF-8 and IO failures explicitly', async () => {
    const storage = fakeStorage();
    const base = await serve(storage);
    const send = (id: string, body: string | Buffer) => fetch(`${base}/sessions/${id}/text-attachments`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body,
    });
    expect((await send('missing', 'x')).status).toBe(404);
    expect((await send('s1', Buffer.from([0xc3, 0x28]))).status).toBe(400);
    storage.write.mockRejectedValueOnce(new Error('private content'));
    const failed = await send('s1', 'secret');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private content');
  });

  it('rejects non-UTF-8 declared encodings before saving', async () => {
    const storage = fakeStorage();
    const base = await serve(storage);
    const response = await fetch(`${base}/sessions/s1/text-attachments`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-16' }, body: 'x',
    });
    expect(response.status).toBe(415);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('exposes metadata and explicit manual deletion without a content endpoint', async () => {
    const storage = fakeStorage();
    const base = await serve(storage);
    const response = await fetch(`${base}/text-attachments`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], files: 0, totalBytes: 0, limits: textAttachmentsDefaults });
    const id = '00000000-0000-4000-8000-000000000001';
    const removed = await fetch(`${base}/text-attachments/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ attachmentId: id });
    expect((await fetch(`${base}/text-attachments/${id}`)).status).toBe(404);
  });
});
