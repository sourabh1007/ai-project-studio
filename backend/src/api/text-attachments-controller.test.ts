import { describe, expect, it, vi } from 'vitest';
import { createTextAttachmentRoutes } from './text-attachments-controller.js';
import { TextAttachmentError } from '../text-attachments/text-attachments-contract.js';

describe('text attachment route', () => {
  it('passes the raw body and cancellation to the session scoped service', async () => {
    const attachment = { sessionId: 's1', path: 'C:\\owned\\p.txt', attachmentId: 'attachment-1', name: 'p.txt', bytes: 1 };
    const create = vi.fn(async () => attachment);
    const [route] = createTextAttachmentRoutes({ create, list: vi.fn(), remove: vi.fn() });
    const body = Buffer.from('x');
    const signal = new AbortController().signal;
    expect(route).toMatchObject({ method: 'post', path: '/sessions/:sessionId/text-attachments' });
    await expect(route.handler({ params: { sessionId: 's1' }, query: {}, body, signal })).resolves.toEqual({
      status: 201, body: attachment,
    });
    expect(create).toHaveBeenCalledWith('s1', body, signal);
  });

  it('returns explicit expected failures and propagates programmer faults', async () => {
    const create = vi.fn().mockRejectedValueOnce(new TextAttachmentError('quota', 507)).mockRejectedValueOnce(new Error('bug'));
    const [route] = createTextAttachmentRoutes({ create, list: vi.fn(), remove: vi.fn() });
    const request = { params: { sessionId: 's1' }, query: {}, body: Buffer.from('x') };
    await expect(route.handler(request)).resolves.toEqual({
      status: 507, body: { error: { kind: 'text_attachment', code: 'quota', message: 'Text attachment could not be saved.' } },
    });
    await expect(route.handler(request)).rejects.toThrow('bug');
  });

  it('lists metadata and removes only the requested ID, propagating explicit failures', async () => {
    const list = vi.fn().mockResolvedValueOnce({ items: [], files: 0, totalBytes: 0 })
      .mockRejectedValueOnce(new TextAttachmentError('busy', 429));
    const remove = vi.fn().mockResolvedValueOnce({ attachmentId: 'id' })
      .mockRejectedValueOnce(new TextAttachmentError('stale-selection', 409));
    const [, get, del] = createTextAttachmentRoutes({ create: vi.fn(), list, remove });
    const signal = new AbortController().signal;
    const request = { params: { attachmentId: 'id' }, query: {}, body: null, signal };
    expect(get).toMatchObject({ method: 'get', path: '/text-attachments' });
    expect(del).toMatchObject({ method: 'delete', path: '/text-attachments/:attachmentId' });
    await expect(get.handler(request)).resolves.toMatchObject({ status: 200, body: { items: [] } });
    expect(list).toHaveBeenCalledWith(signal);
    await expect(get.handler(request)).resolves.toMatchObject({ status: 429 });
    await expect(del.handler(request)).resolves.toEqual({ status: 200, body: { attachmentId: 'id' } });
    expect(remove).toHaveBeenCalledWith('id', signal);
    await expect(del.handler(request)).resolves.toMatchObject({ status: 409 });
  });
});
