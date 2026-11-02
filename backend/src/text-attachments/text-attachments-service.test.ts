import { describe, expect, it, vi } from 'vitest';
import { createTextAttachments } from './text-attachments-service.js';
import { TextAttachmentError, textAttachmentFailure } from './text-attachments-contract.js';
import { textAttachmentsConfigSchema, textAttachmentsDefaults } from './config.js';
import type { Session } from '../session/session-contract.js';

function setup() {
  const storage = {
    usage: vi.fn(async () => ({ files: 0, bytes: 0 })),
    list: vi.fn(async () => ({ items: [], files: 0, totalBytes: 0 })),
    remove: vi.fn(async (_attachmentId: string, _signal?: AbortSignal) => undefined),
    write: vi.fn(async (_sessionId: string, _content: Uint8Array, _signal?: AbortSignal) => ({ path: 'C:\\owned\\paste.txt', name: 'paste.txt', attachmentId: 'attachment-1' })),
  };
  const sessions = { get: vi.fn(() => ({ id: 's1' }) as Session | null) };
  const reportFailure = vi.fn();
  return { storage, sessions, reportFailure, service: createTextAttachments({ storage, sessions, config: textAttachmentsDefaults, reportFailure }) };
}

describe('text attachment config', () => {
  it('accepts defaults and rejects values beyond the hard safety ceilings', () => {
    expect(textAttachmentsConfigSchema.parse(textAttachmentsDefaults)).toEqual(textAttachmentsDefaults);
    for (const [field, value] of [['fileBytes', 4194305], ['files', 65], ['totalBytes', 67108865], ['files', 0]]) {
      expect(textAttachmentsConfigSchema.safeParse({ ...textAttachmentsDefaults, [field]: value }).success).toBe(false);
    }
  });
});

describe('text attachments', () => {
  it('reports only fixed failure codes and allowlisted error names, never arbitrary thrown values', () => {
    expect(textAttachmentFailure('storage-unavailable', new TypeError('secret'))).toEqual({ code: 'storage-unavailable', errorName: 'TypeError' });
    expect(textAttachmentFailure('cleanup-unconfirmed', Object.assign(new Error('secret'), { name: 'secret' }))).toEqual({ code: 'cleanup-unconfirmed', errorName: 'Error' });
    expect(textAttachmentFailure('storage-unavailable', 'secret')).toEqual({ code: 'storage-unavailable', errorName: 'Error' });
  });
  it('saves exact multi-byte UTF-8 bytes at the 4 MiB boundary without changing newlines or BOM', async () => {
    const { storage, service } = setup();
    const content = Buffer.from('\ufeff\r\n' + '😀'.repeat(1048574) + 'abc');
    expect(content.byteLength).toBe(textAttachmentsDefaults.fileBytes);
    const signal = new AbortController().signal;
    await expect(service.create('s1', content, signal)).resolves.toEqual({
      sessionId: 's1', path: 'C:\\owned\\paste.txt', name: 'paste.txt', attachmentId: 'attachment-1', bytes: content.byteLength,
    });
    expect(storage.write.mock.calls[0][0]).toBe('s1');
    expect(storage.write.mock.calls[0][1]).toBe(content);
    expect(storage.write.mock.calls[0][2]).toBe(signal);
  });

  it.each(['../escape', '', 'a'.repeat(129), 'a/b', 'a\\b'])('rejects unsafe session id %s', async (id) => {
    const { service, sessions } = setup();
    await expect(service.create(id, Buffer.from('text'))).rejects.toMatchObject({ code: 'invalid-session', status: 400 });
    expect(sessions.get).not.toHaveBeenCalled();
  });

  it('requires an existing session', async () => {
    const { service, sessions, storage } = setup();
    sessions.get.mockReturnValue(null);
    await expect(service.create('s1', Buffer.from('text'))).rejects.toMatchObject({ code: 'unknown-session', status: 404 });
    expect(storage.usage).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'not bytes', new Uint8Array()])('rejects non-byte or empty bodies', async (content) => {
    const { service } = setup();
    await expect(service.create('s1', content)).rejects.toMatchObject({ code: 'invalid-text' });
  });

  it('enforces UTF-8 byte rather than UTF-16 character limits', async () => {
    const { service } = setup();
    await expect(service.create('s1', Buffer.from('😀'.repeat(1048576) + 'a')))
      .rejects.toMatchObject({ code: 'text-too-large', status: 413 });
    await expect(service.create('s1', Uint8Array.from([0xc3, 0x28])))
      .rejects.toMatchObject({ code: 'invalid-utf8', status: 400 });
  });

  it('rejects cancellation before any IO', async () => {
    const { service, storage } = setup();
    await expect(service.create('s1', Buffer.from('x'), AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(storage.usage).not.toHaveBeenCalled();
  });

  it('rejects cancellation while accounting without writing and releases admission', async () => {
    const { service, storage } = setup();
    const controller = new AbortController();
    storage.usage.mockImplementationOnce(async () => {
      controller.abort();
      return { files: 0, bytes: 0 };
    });
    await expect(service.create('s1', Buffer.from('x'), controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(storage.write).not.toHaveBeenCalled();
    await expect(service.create('s1', Buffer.from('x'))).resolves.toMatchObject({ bytes: 1 });
  });

  it.each([
    { files: 64, bytes: 0 },
    { files: 0, bytes: textAttachmentsDefaults.totalBytes },
  ])('enforces retained storage quotas %o', async (usage) => {
    const { service, storage } = setup();
    storage.usage.mockResolvedValue(usage);
    await expect(service.create('s1', Buffer.from('x'))).rejects.toMatchObject({ code: 'quota', status: 507 });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('accepts the exact total byte boundary', async () => {
    const { service, storage } = setup();
    storage.usage.mockResolvedValue({ files: 63, bytes: textAttachmentsDefaults.totalBytes - 1 });
    await expect(service.create('s1', Buffer.from('x'))).resolves.toMatchObject({ bytes: 1 });
  });

  it('does not queue concurrent writes, then recovers after failure without leaking text', async () => {
    const { service, storage } = setup();
    let reject!: (error: Error) => void;
    storage.usage.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = service.create('s1', Buffer.from('private secret'));
    await expect(service.create('s1', Buffer.from('next'))).rejects.toMatchObject({ code: 'busy', status: 429 });
    reject(new Error('private secret'));
    await expect(first).rejects.toMatchObject({ code: 'storage-unavailable', status: 503, message: 'Text attachment could not be saved.' });
    await expect(service.create('s1', Buffer.from('next'))).resolves.toMatchObject({ bytes: 4 });
  });

  it('preserves explicit storage failures and sanitizes unexpected write errors', async () => {
    const { service, storage, reportFailure } = setup();
    storage.write.mockRejectedValueOnce(new TextAttachmentError('unsafe-storage', 503));
    await expect(service.create('s1', Buffer.from('secret'))).rejects.toMatchObject({ code: 'unsafe-storage' });
    expect(reportFailure).not.toHaveBeenCalled();
    storage.write.mockRejectedValueOnce(new Error('secret'));
    await expect(service.create('s1', Buffer.from('secret'))).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith({ code: 'storage-unavailable', errorName: 'Error' });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain('secret');
  });

  it('lists bounded metadata with configured limits and removes an explicitly selected UUID', async () => {
    const { service, storage } = setup();
    const signal = new AbortController().signal;
    await expect(service.list(signal)).resolves.toEqual({
      items: [], files: 0, totalBytes: 0, limits: textAttachmentsDefaults,
    });
    const id = '00000000-0000-4000-8000-000000000001';
    await expect(service.remove(id, signal)).resolves.toEqual({ attachmentId: id });
    expect(storage.remove).toHaveBeenCalledWith(id, signal);
    await expect(service.remove('../escape')).rejects.toMatchObject({ code: 'invalid-attachment-id', status: 400 });
  });

  it('uses the same fail-fast critical section for create, list and manual removal', async () => {
    const { service, storage } = setup();
    const id = '00000000-0000-4000-8000-000000000001';
    let release!: () => void;
    storage.remove.mockImplementationOnce(async () => new Promise<undefined>((resolve) => {
      release = () => resolve(undefined);
    }));
    const removal = service.remove(id);
    await expect(service.list()).rejects.toMatchObject({ code: 'busy', status: 429 });
    await expect(service.create('s1', Buffer.from('x'))).rejects.toMatchObject({ code: 'busy', status: 429 });
    release();
    await removal;
    await expect(service.list()).resolves.toMatchObject({ files: 0 });
    await expect(service.remove(id, AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports list and removal IO errors through the same safe diagnostic path', async () => {
    const { service, storage, reportFailure } = setup();
    storage.list.mockRejectedValueOnce(new Error('secret'));
    await expect(service.list()).rejects.toMatchObject({ code: 'storage-unavailable', status: 503 });
    storage.remove.mockRejectedValueOnce(new Error('secret'));
    await expect(service.remove('00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'storage-unavailable', status: 503 });
    expect(reportFailure).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain('secret');
  });
});
