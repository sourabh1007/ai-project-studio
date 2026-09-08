'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, files: 64,
  pixels: 16 * 1024 * 1024, dimension: 8192, sourcePaths: 32, sourceBytes: 65536,
});
const ownedName = /^att-[a-f0-9]{64}-[a-f0-9]{32}\.png$/;
const validSession = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const fail = (code) => Object.assign(new Error(code), { attachmentCode: code });
const identityMatches = (a, b) => a.dev === b.dev && a.ino === b.ino;

function createOwnedAttachmentStore({ root, io = fs, randomId = () => randomBytes(16).toString('hex'), limits = LIMITS }) {
  root = path.resolve(root);
  const issued = new Map();
  let selections = new Map();
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const checkRoot = () => {
    const stat = io.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(io.realpathSync(root), root)) {
      throw fail('unsafe-storage');
    }
  };
  const scan = (enforceByteQuota = true) => {
    io.mkdirSync(root, { recursive: true, mode: 0o700 });
    checkRoot();
    let count = 0;
    let bytes = 0;
    const files = [];
    const directory = io.opendirSync(root, { bufferSize: 16 });
    try {
      for (let entry; (entry = directory.readSync());) {
        if (++count > limits.files) throw fail('quota');
        if (!ownedName.test(entry.name)) throw fail('unsafe-storage');
        const stat = io.lstatSync(path.join(root, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('unsafe-storage');
        bytes += stat.size;
        if (enforceByteQuota && bytes > limits.totalBytes) throw fail('quota');
        files.push({ name: entry.name, stat });
      }
    } finally {
      directory.closeSync();
    }
    return { count, bytes, files };
  };
  const sessionHash = (sessionId) => createHash('sha256').update(sessionId).digest('hex');
  const removeIssued = (lease) => {
    checkRoot();
    const stat = io.lstatSync(lease.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !identityMatches(stat, lease.identity)) {
      throw fail('unsafe-storage');
    }
    io.unlinkSync(lease.path);
  };
  const selectedFiles = (ids) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > limits.files ||
        new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !selections.has(id))) {
      throw fail('invalid-selection');
    }
    checkRoot();
    return ids.map((id) => {
      const selected = selections.get(id);
      const stat = io.lstatSync(selected.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          !identityMatches(stat, selected.identity) || stat.size !== selected.identity.size ||
          stat.mtimeMs !== selected.identity.mtimeMs || stat.ctimeMs !== selected.identity.ctimeMs) {
        throw fail('stale-selection');
      }
      return { id, ...selected };
    });
  };
  return {
    limits,
    list() {
      selections = new Map();
      const usage = scan(false);
      const items = usage.files.map(({ name, stat }) => {
        const id = randomBytes(16).toString('hex');
        selections.set(id, { path: path.join(root, name), identity: stat });
        return { id, name, bytes: stat.size, createdAt: new Date(stat.birthtimeMs).toISOString() };
      });
      return {
        status: 'ready', items, totalBytes: usage.bytes,
        limits: { files: limits.files, totalBytes: limits.totalBytes, fileBytes: limits.fileBytes },
      };
    },
    describeRemoval(ids) {
      const files = selectedFiles(ids);
      return { count: files.length, bytes: files.reduce((total, file) => total + file.identity.size, 0) };
    },
    // Manual user-authorized destruction is separate from safe automatic lease release.
    removeSelected(ids) {
      let deleted = 0;
      try {
        const files = selectedFiles(ids);
        for (const file of files) {
          selectedFiles([file.id]);
          removeIssued(file);
          selections.delete(file.id);
          for (const [id, lease] of issued) {
            if (lease.path === file.path && identityMatches(lease.identity, file.identity)) issued.delete(id);
          }
          deleted++;
        }
        return { status: 'deleted', deleted };
      } catch (error) {
        throw Object.assign(fail(error.attachmentCode || 'attachment-unavailable'), { deleted });
      }
    },
    assertCapacity() {
      const usage = scan();
      if (issued.size >= limits.files || usage.count >= limits.files || usage.bytes >= limits.totalBytes) throw fail('quota');
    },
    save(sessionId, png) {
      if (!validSession(sessionId)) throw fail('invalid-session');
      if (!Buffer.isBuffer(png) || !png.length || png.length > limits.fileBytes) throw fail('image-too-large');
      const usage = scan();
      if (issued.size >= limits.files || usage.count >= limits.files || usage.bytes + png.length > limits.totalBytes) throw fail('quota');
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = randomId();
        if (!/^[a-f0-9]{32}$/.test(id)) throw fail('unsafe-storage');
        if (issued.has(id)) continue;
        const file = path.join(root, `att-${sessionHash(sessionId)}-${id}.png`);
        let fd;
        let identity;
        try {
          fd = io.openSync(file, 'wx', 0o600);
          identity = io.fstatSync(fd);
          checkRoot();
          if (!samePath(io.realpathSync(file), file)) throw fail('unsafe-storage');
          io.writeFileSync(fd, png);
          io.fsyncSync(fd);
          io.closeSync(fd);
          fd = undefined;
          checkRoot();
          const written = io.lstatSync(file);
          if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1 ||
              !identityMatches(written, identity) || written.size !== png.length) throw fail('unsafe-storage');
          issued.set(id, { sessionId, path: file, identity });
          return { status: 'ready', source: 'clipboard-image', paths: [file], attachmentId: id, sessionId };
        } catch (error) {
          if (fd !== undefined) {
            try { io.closeSync(fd); } catch { /* Retain uncertain files; restart accounting includes them. */ }
          }
          if (identity) {
            try { removeIssued({ path: file, identity }); } catch { /* Never delete a replaced or uncertain file. */ }
          }
          if (error.code === 'EEXIST') continue;
          throw error;
        }
      }
      throw fail('collision');
    },
    // Not exposed to renderer IPC. A trusted lifecycle owner must establish
    // that no provider/current or resumable session can use this lease again.
    // A file index or terminal paste acknowledgement is NOT that confirmation.
    releaseConfirmedUnused(sessionId, attachmentId) {
      const lease = issued.get(attachmentId);
      if (!lease || lease.sessionId !== sessionId) return false;
      removeIssued(lease);
      issued.delete(attachmentId);
      return true;
    },
  };
}

function registerAttachmentManagementIpc({ ipcMain, isTrustedSender, getStore, confirmRemoval }) {
  ipcMain.handle('attachments:list', (event) => {
    if (!isTrustedSender(event)) return { status: 'error', error: 'untrusted' };
    try { return getStore().list(); } catch (error) {
      return { status: 'error', error: error.attachmentCode || 'attachment-unavailable' };
    }
  });
  ipcMain.handle('attachments:remove', async (event, request) => {
    if (!isTrustedSender(event)) return { status: 'error', error: 'untrusted' };
    try {
      const store = getStore();
      const ids = request?.ids;
      const description = store.describeRemoval(ids);
      if (!(await confirmRemoval(description))) return { status: 'cancelled' };
      if (!isTrustedSender(event)) return { status: 'error', error: 'untrusted' };
      return store.removeSelected(ids);
    } catch (error) {
      return { status: 'error', error: error.attachmentCode || 'attachment-unavailable', deleted: error.deleted || 0 };
    }
  });
}

function readSourcePaths(clipboard, platform) {
  let paths = [];
  if (platform === 'win32' && clipboard.has('FileNameW')) {
    const raw = clipboard.readBuffer('FileNameW');
    if (raw.length > LIMITS.sourceBytes || raw.length % 2) throw fail('invalid-paths');
    paths = raw.toString('utf16le').split('\0').filter(Boolean);
  } else {
    for (const format of ['text/uri-list', 'public.file-url']) {
      if (!clipboard.has(format)) continue;
      const raw = clipboard.read(format);
      if (Buffer.byteLength(raw, 'utf8') > LIMITS.sourceBytes) throw fail('invalid-paths');
      paths = raw.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
        const url = new URL(line);
        if (url.protocol !== 'file:') throw fail('invalid-paths');
        return fileURLToPath(url);
      });
      break;
    }
  }
  const absolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (paths.length > LIMITS.sourcePaths || paths.some((value) =>
    !absolute(value) || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096)) throw fail('invalid-paths');
  return paths;
}

function readClipboardAttachment({ clipboard, store, sessionId, platform = process.platform }) {
  if (!validSession(sessionId)) return { status: 'error', error: 'invalid-session' };
  try {
    const paths = readSourcePaths(clipboard, platform);
    if (paths.length) return { status: 'ready', source: 'clipboard-files', paths };
    const image = clipboard.readImage();
    if (image.isEmpty()) return { status: 'none' };
    const { width, height } = image.getSize(1);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
        width > store.limits.dimension || height > store.limits.dimension ||
        width * height > store.limits.pixels) throw fail('image-too-large');
    store.assertCapacity();
    return store.save(sessionId, image.toPNG({ scaleFactor: 1 }));
  } catch (error) {
    return { status: 'error', error: error.attachmentCode || 'attachment-unavailable' };
  }
}

module.exports = { createOwnedAttachmentStore, readClipboardAttachment, registerAttachmentManagementIpc, LIMITS };
