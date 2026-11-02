import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TextAttachmentsConfig } from './config.js';
import { TextAttachmentError, textAttachmentFailure, textAttachmentIdPattern, type TextAttachmentFailureReporter, type TextAttachmentStorage } from './text-attachments-contract.js';

const ownedName = /^paste-[a-f0-9]{16}-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.txt$/;
const unsafe = () => new TextAttachmentError('unsafe-storage', 503);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Retained files are never removed merely because a terminal acknowledged a paste. */
export function createTextAttachmentStorage(root: string, config: TextAttachmentsConfig, reportFailure: TextAttachmentFailureReporter): TextAttachmentStorage {
  const requestedRoot = resolve(root);
  let rootIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  let selections = new Map<string, { path: string; identity: Awaited<ReturnType<typeof lstat>> }>();
  const checkRoot = async () => {
    const requested = await lstat(requestedRoot);
    if (!requested.isDirectory() || requested.isSymbolicLink() ||
      requested.dev !== rootIdentity!.dev || requested.ino !== rootIdentity!.ino) throw unsafe();
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(root), root) ||
      stat.dev !== rootIdentity!.dev || stat.ino !== rootIdentity!.ino) throw unsafe();
  };
  const prepareRoot = async () => {
    if (!rootIdentity) {
      await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
      const requested = await lstat(requestedRoot);
      if (!requested.isDirectory() || requested.isSymbolicLink()) throw unsafe();
      const canonicalRoot = await realpath(requestedRoot);
      const canonical = await lstat(canonicalRoot);
      if (!canonical.isDirectory() || canonical.isSymbolicLink() ||
        canonical.dev !== requested.dev || canonical.ino !== requested.ino) throw unsafe();
      root = canonicalRoot;
      rootIdentity = canonical;
    }
    await checkRoot();
  };
  const scan = async (enforceQuota: boolean) => {
    await prepareRoot();
    let scanned = 0;
    let bytes = 0;
    const files = [];
    const directory = await opendir(root, { bufferSize: 16 });
    for await (const entry of directory) {
      if (++scanned > config.files + 128) throw new TextAttachmentError('scan-limit', 507);
      const owned = ownedName.exec(entry.name);
      if (!owned) continue;
      const path = join(root, entry.name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe();
      bytes += stat.size;
      files.push({ attachmentId: owned[1], path, name: entry.name, identity: stat });
      if (enforceQuota && (files.length > config.files || bytes > config.totalBytes)) throw new TextAttachmentError('quota', 507);
    }
    return { files, bytes };
  };
  const sameFile = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) =>
    a.isFile() && !a.isSymbolicLink() && a.nlink === 1 && a.dev === b.dev && a.ino === b.ino &&
    // Windows reads can update ctime without changing either file identity or content.
    a.size === b.size && a.mtimeMs === b.mtimeMs && (process.platform === 'win32' || a.ctimeMs === b.ctimeMs);
  return {
    async usage() {
      const result = await scan(true);
      return { files: result.files.length, bytes: result.bytes };
    },
    async list() {
      const result = await scan(false);
      const selected = new Map<string, { path: string; identity: Awaited<ReturnType<typeof lstat>> }>();
      const items = result.files.map((file) => {
        if (selected.has(file.attachmentId)) throw unsafe();
        selected.set(file.attachmentId, { path: file.path, identity: file.identity });
        return {
          attachmentId: file.attachmentId, name: file.name, path: file.path,
          bytes: file.identity.size, modifiedAt: file.identity.mtime.toISOString(),
        };
      });
      selections = selected;
      return { items, totalBytes: result.bytes, files: items.length };
    },
    async remove(attachmentId, signal) {
      if (!textAttachmentIdPattern.test(attachmentId)) throw new TextAttachmentError('invalid-attachment-id', 400);
      const result = await scan(false);
      const matches = result.files.filter((file) => file.attachmentId === attachmentId);
      if (!matches.length) throw new TextAttachmentError('not-found', 404);
      if (matches.length !== 1) throw unsafe();
      const selected = selections.get(attachmentId);
      if (!selected || !sameFile(matches[0].identity, selected.identity)) throw new TextAttachmentError('stale-selection', 409);
      await checkRoot();
      try {
        const current = await lstat(selected.path);
        if (!sameFile(current, selected.identity)) throw new TextAttachmentError('stale-selection', 409);
        signal?.throwIfAborted();
        await unlink(selected.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TextAttachmentError('not-found', 404);
        throw error;
      }
      selections.delete(attachmentId);
    },
    async write(sessionId, content, signal) {
      await prepareRoot();
      const sessionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
      const attachmentId = randomUUID();
      const name = `paste-${sessionHash}-${attachmentId}.txt`;
      const path = join(root, name);
      if (process.platform === 'win32' && path.length > 240) throw unsafe();
      await checkRoot();
      signal?.throwIfAborted();
      const file = await open(path, 'wx', 0o600);
      let identity: Awaited<ReturnType<typeof file.stat>> | undefined;
      try {
        identity = await file.stat();
        await checkRoot();
        await file.writeFile(content, { signal });
        await file.sync();
        await file.close();
        await checkRoot();
        const written = await lstat(path);
        if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1 ||
          written.dev !== identity.dev || written.ino !== identity.ino || written.size !== content.byteLength) throw unsafe();
        signal?.throwIfAborted();
        selections.set(attachmentId, { path, identity: written });
        return { path, name, attachmentId };
      } catch (error) {
        await file.close().catch((closeError: unknown) =>
          reportFailure(textAttachmentFailure('cleanup-unconfirmed', closeError)));
        try {
          await checkRoot();
          const current = await lstat(path);
          if (!identity || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
            current.dev !== identity.dev || current.ino !== identity.ino) throw unsafe();
          await unlink(path);
        } catch (cleanupError) {
          // Retain uncertain files; the next quota scan still counts them.
          reportFailure(textAttachmentFailure('cleanup-unconfirmed', cleanupError));
        }
        throw error;
      }
    },
  };
}
