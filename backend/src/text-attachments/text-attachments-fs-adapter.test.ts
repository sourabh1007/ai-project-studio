import { randomUUID } from 'node:crypto';
import { readdirSync, renameSync, writeFileSync } from 'node:fs';
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextAttachmentStorage as createStorage } from './text-attachments-fs-adapter.js';
import { textAttachmentsDefaults, type TextAttachmentsConfig } from './config.js';
import type { TextAttachmentFailureReporter } from './text-attachments-contract.js';
import { createTextAttachments } from './text-attachments-service.js';
import type { Session } from '../session/session-contract.js';

const createTextAttachmentStorage = (root: string, config: TextAttachmentsConfig, reportFailure: TextAttachmentFailureReporter = vi.fn()) =>
  createStorage(root, config, reportFailure);

const roots: string[] = [];
function directory() {
  const root = resolve(`.text-attachment-test-${randomUUID()}`);
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('asynchronous retained text attachment IO', () => {
  it('round-trips full-size multi-byte text with a safe session-derived filename and restart accounting', async () => {
    const root = directory();
    const storage = createTextAttachmentStorage(root, textAttachmentsDefaults);
    expect(await storage.usage()).toEqual({ files: 0, bytes: 0 });
    const text = Buffer.from('😀'.repeat(1048576));
    const saved = await storage.write('session_1', text);
    expect(saved.name).toMatch(/^paste-[a-f0-9]{16}-[a-f0-9-]{36}\.txt$/);
    expect(saved.path).toBe(join(root, saved.name));
    expect((await readFile(saved.path)).equals(text)).toBe(true);
    expect((await lstat(saved.path)).nlink).toBe(1);
    expect(await createTextAttachmentStorage(root, textAttachmentsDefaults).usage()).toEqual({ files: 1, bytes: text.length });
  });

  it('preserves exact UTF-8 bytes including BOM, combining marks, newlines and trailing spaces', async () => {
    const storage = createTextAttachmentStorage(directory(), textAttachmentsDefaults);
    await storage.usage();
    const bytes = Buffer.from('\ufeffHi e\u0301\r\n世界\n😀  ');
    const saved = await storage.write('s1', bytes);
    expect(await readFile(saved.path)).toEqual(bytes);
  });

  it('canonicalizes trusted parent aliases while refusing direct-root substitution after initialization', async () => {
    const target = directory();
    await mkdir(target);
    const alias = directory();
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const requestedRoot = join(alias, 'attachments');
    const canonicalRoot = join(await realpath(target), 'attachments');
    const storage = createTextAttachmentStorage(requestedRoot, textAttachmentsDefaults);
    expect(await storage.usage()).toEqual({ files: 0, bytes: 0 });
    const saved = await storage.write('s1', Buffer.from('retained'));
    expect(saved.path).toBe(join(canonicalRoot, saved.name));
    expect(await readFile(saved.path, 'utf8')).toBe('retained');

    await rename(canonicalRoot, join(target, 'previous'));
    await mkdir(canonicalRoot);
    await expect(storage.usage()).rejects.toMatchObject({ code: 'unsafe-storage' });
    expect(await readFile(join(target, 'previous', saved.name), 'utf8')).toBe('retained');
    await rm(canonicalRoot, { recursive: true });
    await symlink(join(target, 'previous'), canonicalRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(storage.usage()).rejects.toMatchObject({ code: 'unsafe-storage' });
  });

  it('rejects root files and root junctions, while retaining unrelated directory entries', async () => {
    const rootFile = directory();
    await writeFile(rootFile, 'private');
    await expect(createTextAttachmentStorage(rootFile, textAttachmentsDefaults).usage()).rejects.toThrow();
    expect(await readFile(rootFile, 'utf8')).toBe('private');

    const target = directory();
    await mkdir(target);
    const junction = directory();
    await symlink(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createTextAttachmentStorage(junction, textAttachmentsDefaults).usage()).rejects.toMatchObject({ code: 'unsafe-storage' });
    expect(await readdir(target)).toEqual([]);

    const root = directory();
    await mkdir(root);
    await writeFile(join(root, 'user.txt'), 'retain');
    await expect(createTextAttachmentStorage(root, textAttachmentsDefaults).usage()).resolves.toEqual({ files: 0, bytes: 0 });
    expect(await readFile(join(root, 'user.txt'), 'utf8')).toBe('retain');
  });

  it('rejects hard-linked or replaced owned paths', async () => {
    const root = directory();
    const storage = createTextAttachmentStorage(root, textAttachmentsDefaults);
    await storage.usage();
    const saved = await storage.write('s1', Buffer.from('retain'));
    const external = directory();
    await link(saved.path, external);
    await expect(storage.usage()).rejects.toMatchObject({ code: 'unsafe-storage' });
    expect(await readFile(external, 'utf8')).toBe('retain');
  });

  it('stops scanning when retained count or bytes exceeds the configured bound', async () => {
    const root = directory();
    const storage = createTextAttachmentStorage(root, textAttachmentsDefaults);
    await storage.usage();
    await storage.write('s1', Buffer.from('xx'));
    await storage.write('s1', Buffer.from('xx'));
    await expect(createTextAttachmentStorage(root, { ...textAttachmentsDefaults, files: 1 }).usage()).rejects.toMatchObject({ code: 'quota' });
    await expect(createTextAttachmentStorage(root, { ...textAttachmentsDefaults, totalBytes: 1 }).usage()).rejects.toMatchObject({ code: 'quota' });
  });

  it('does not create a file for an already cancelled write', async () => {
    const root = directory();
    const storage = createTextAttachmentStorage(root, textAttachmentsDefaults);
    await storage.usage();
    await expect(storage.write('s1', Buffer.from('secret'), AbortSignal.abort())).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('removes its own completed file if cancellation arrives before returning the reference', async () => {
    const root = directory();
    const storage = createTextAttachmentStorage(root, textAttachmentsDefaults);
    await storage.usage();
    const controller = new AbortController();
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks === 2) controller.abort();
      check();
    });
    await expect(storage.write('s1', Buffer.from('secret'), controller.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    expect(await storage.usage()).toEqual({ files: 0, bytes: 0 });
  });

  it('reports uncertain cleanup without exposing content or removing a substituted file', async () => {
    const root = directory();
    const reportFailure = vi.fn();
    const storage = createTextAttachmentStorage(root, textAttachmentsDefaults, reportFailure);
    await storage.usage();
    const controller = new AbortController();
    let checks = 0;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks !== 2) return;
      const path = join(root, readdirSync(root)[0]);
      renameSync(path, `${path}.retained`);
      writeFileSync(path, 'private replacement');
      throw new Error('private original');
    });
    await expect(storage.write('s1', Buffer.from('private original'), controller.signal)).rejects.toThrow('private original');
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith({ code: 'cleanup-unconfirmed', errorName: 'Error' });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain('private');
    const remaining = await readdir(root);
    expect(remaining).toHaveLength(2);
    const replacement = remaining.find((name) => name.endsWith('.txt'))!;
    expect(await readFile(join(root, replacement), 'utf8')).toBe('private replacement');
  });

  it('lists metadata without reading content and manual deletion explicitly restores capacity', async () => {
    const config = { ...textAttachmentsDefaults, files: 1 };
    const storage = createTextAttachmentStorage(directory(), config);
    const service = createTextAttachments({
      storage, config, sessions: { get: () => ({ id: 's1' }) as Session }, reportFailure: vi.fn(),
    });
    const first = await service.create('s1', Buffer.from('retained'));
    await expect(service.create('s1', Buffer.from('next'))).rejects.toMatchObject({ code: 'quota', status: 507 });
    const listing = await service.list();
    expect(listing).toMatchObject({
      files: 1, totalBytes: 8, limits: config,
      items: [{ attachmentId: first.attachmentId, name: first.name, path: first.path, bytes: 8 }],
    });
    expect(Number.isNaN(Date.parse(listing.items[0].modifiedAt))).toBe(false);
    expect(await readFile(first.path, 'utf8')).toBe('retained');
    await expect(service.remove(first.attachmentId)).resolves.toEqual({ attachmentId: first.attachmentId });
    expect(await storage.list()).toEqual({ items: [], files: 0, totalBytes: 0 });
    await expect(service.create('s1', Buffer.from('next'))).resolves.toMatchObject({ bytes: 4 });
  });

  it('requires a current confirmation snapshot and rejects stale or nonexistent selections explicitly', async () => {
    const root = directory();
    const original = createTextAttachmentStorage(root, textAttachmentsDefaults);
    await original.usage();
    const saved = await original.write('s1', Buffer.from('retained'));
    const restarted = createTextAttachmentStorage(root, textAttachmentsDefaults);
    await expect(restarted.remove(saved.attachmentId)).rejects.toMatchObject({ code: 'stale-selection', status: 409 });
    await restarted.list();
    await writeFile(saved.path, 'replacement content');
    await expect(restarted.remove(saved.attachmentId)).rejects.toMatchObject({ code: 'stale-selection', status: 409 });
    expect(await readFile(saved.path, 'utf8')).toBe('replacement content');
    await restarted.list();
    await restarted.remove(saved.attachmentId);
    await expect(restarted.remove(saved.attachmentId)).rejects.toMatchObject({ code: 'not-found', status: 404 });
    await expect(restarted.remove('../escape')).rejects.toMatchObject({ code: 'invalid-attachment-id', status: 400 });
  });

  it('ignores .DS_Store, Thumbs.db and non-owned junctions without following them', async () => {
    const root = directory();
    await mkdir(root);
    await writeFile(join(root, '.DS_Store'), 'metadata');
    await writeFile(join(root, 'Thumbs.db'), 'metadata');
    const external = directory();
    await mkdir(external);
    await writeFile(join(external, 'private'), 'private');
    await symlink(external, join(root, 'unrelated-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const storage = createTextAttachmentStorage(root, textAttachmentsDefaults);
    expect(await storage.usage()).toEqual({ files: 0, bytes: 0 });
    expect(await storage.list()).toEqual({ items: [], files: 0, totalBytes: 0 });
    const saved = await storage.write('s1', Buffer.from('retained'));
    await unlink(saved.path);
    await symlink(external, saved.path, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(storage.usage()).rejects.toMatchObject({ code: 'unsafe-storage' });
    await expect(storage.list()).rejects.toMatchObject({ code: 'unsafe-storage' });
    expect(await readFile(join(external, 'private'), 'utf8')).toBe('private');
  });

  it('bounds total directory traversal and permits metadata cleanup when owned file quota is exceeded', async () => {
    const root = directory();
    await mkdir(root);
    await Promise.all(Array.from({ length: 130 }, (_, index) => writeFile(join(root, `unrelated-${index}`), '')));
    const crowded = createTextAttachmentStorage(root, { ...textAttachmentsDefaults, files: 1 });
    await expect(crowded.list()).rejects.toMatchObject({ code: 'scan-limit', status: 507 });

    const storage = createTextAttachmentStorage(directory(), { ...textAttachmentsDefaults, files: 1 });
    await storage.usage();
    const first = await storage.write('s1', Buffer.from('one'));
    await storage.write('s1', Buffer.from('two'));
    await expect(storage.usage()).rejects.toMatchObject({ code: 'quota', status: 507 });
    expect(await storage.list()).toMatchObject({ files: 2, totalBytes: 6 });
    await storage.remove(first.attachmentId);
    expect(await storage.usage()).toEqual({ files: 1, bytes: 3 });
  });

  it('does not delete a confirmed file if the caller cancelled', async () => {
    const storage = createTextAttachmentStorage(directory(), textAttachmentsDefaults);
    await storage.usage();
    const saved = await storage.write('s1', Buffer.from('retained'));
    await storage.list();
    await expect(storage.remove(saved.attachmentId, AbortSignal.abort())).rejects.toThrow();
    expect(await readFile(saved.path, 'utf8')).toBe('retained');
  });
});
