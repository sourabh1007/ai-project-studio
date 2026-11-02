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

/** DROPFILES uses a byte offset, a BOOL fWide, then a double-NUL file list. */
function parseDropFiles(raw, decodeAnsi = (bytes) => {
  // The host ANSI codepage is not available in Node. Never corrupt a path by
  // guessing Windows-1252 on a machine configured for a different codepage.
  if (bytes.some((value) => value > 0x7f)) throw fail('unsupported-ansi-paths');
  return bytes.toString('ascii');
}) {
  if (!Buffer.isBuffer(raw) || raw.length < 20 || raw.length > LIMITS.sourceBytes) throw fail('invalid-paths');
  const offset = raw.readUInt32LE(0);
  const wide = raw.readUInt32LE(16) !== 0;
  const step = wide ? 2 : 1;
  if (offset < 20 || offset > raw.length - step * 2 || (wide && (offset % 2 || (raw.length - offset) % 2))) {
    throw fail('invalid-paths');
  }
  const paths = [];
  let start = offset;
  const zero = (index) => wide ? raw.readUInt16LE(index) === 0 : raw[index] === 0;
  for (let index = offset; index <= raw.length - step; index += step) {
    if (!zero(index)) continue;
    if (index === start) {
      if (paths.length === 0 && (index + step >= raw.length || !zero(index + step))) throw fail('invalid-paths');
      if (raw.subarray(index).some((value) => value !== 0)) throw fail('invalid-paths');
      return paths;
    }
    const bytes = raw.subarray(start, index);
    const value = wide ? bytes.toString('utf16le') : decodeAnsi(bytes);
    if (!value.isWellFormed() || value.includes('\ufffd') || paths.length >= LIMITS.sourcePaths) throw fail('invalid-paths');
    paths.push(value);
    start = index + step;
  }
  throw fail('invalid-paths');
}

function readSourcePaths(clipboard, platform) {
  let paths = [];
  if (platform === 'win32' && clipboard.has('CF_HDROP')) {
    paths = parseDropFiles(clipboard.readBuffer('CF_HDROP'));
  } else if (platform === 'win32' && clipboard.has('FileNameW')) {
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
        return fileURLToPath(url, { windows: platform === 'win32' });
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
    // Legacy Electron decodes inside readImage; capacity can be checked first,
    // but dimensions/encoded length cannot preflight that native decode.
    store.assertCapacity();
    const image = clipboard.readImage();
    if (image.isEmpty()) return { status: 'none' };
    const { width, height } = image.getSize(1);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
        width > store.limits.dimension || height > store.limits.dimension ||
        width * height > store.limits.pixels) throw fail('image-too-large');
    return store.save(sessionId, image.toPNG({ scaleFactor: 1 }));
  } catch (error) {
    return { status: 'error', error: error.attachmentCode || 'attachment-unavailable' };
  }
}

function createClipboardAttachmentReader({ clipboard, nativeImage, platform = process.platform, now = Date.now }) {
  let pending = null;
  let lastRead = -Infinity;
  return function read({ store, sessionId }) {
    if (!validSession(sessionId)) return { status: 'error', error: 'invalid-session' };
    if (pending) return { status: 'error', error: 'clipboard-busy' };
    if (now() - lastRead < 250) return { status: 'error', error: 'clipboard-busy' };
    lastRead = now();
    if (typeof clipboard.readImage === 'function') {
      return readClipboardAttachment({ clipboard, store, sessionId, platform });
    }
    pending = (async () => {
      try {
        const items = await clipboard.read();
        if (!Array.isArray(items) || items.length > LIMITS.sourcePaths) throw fail('invalid-paths');
        const data = new Map();
        let imageItem = null;
        const rawFormat = (type) => /^electron application\/osclipboard;format="([^"]+)"$/.exec(type)?.[1];
        for (const item of items) {
          if (!Array.isArray(item.types) || item.types.length > 64) throw fail('invalid-paths');
          for (const type of item.types) {
            const format = rawFormat(type) || type;
            if (!['CF_HDROP', 'FileNameW', 'text/uri-list', 'public.file-url', 'image/png'].includes(format)) continue;
            if (format === 'image/png') {
              if (imageItem) throw fail('invalid-image');
              imageItem = { item, type };
              continue;
            }
            if (data.has(format)) throw fail('invalid-paths');
            const blob = await item.getType(type);
            if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > LIMITS.sourceBytes) {
              throw fail('invalid-paths');
            }
            data.set(format, Buffer.from(await blob.arrayBuffer()));
          }
        }
        const snapshot = {
          has: (format) => data.has(format),
          readBuffer: (format) => data.get(format),
          read: (format) => data.get(format).toString('utf8'),
        };
        const paths = readSourcePaths(snapshot, platform);
        if (paths.length) return { status: 'ready', source: 'clipboard-files', paths };
        if (!imageItem) return { status: 'none' };
        store.assertCapacity();
        const blob = await imageItem.item.getType(imageItem.type);
        if (!Number.isSafeInteger(blob.size) || blob.size <= 0 || blob.size > store.limits.fileBytes) throw fail('image-too-large');
        const png = Buffer.from(await blob.arrayBuffer());
        // Electron 44 exposes a Blob; reject oversized PNG dimensions before
        // our own nativeImage decode. This does not bound OS clipboard work.
        if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
            png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') throw fail('invalid-image');
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        if (!width || !height || width > store.limits.dimension || height > store.limits.dimension ||
            width * height > store.limits.pixels) throw fail('image-too-large');
        const image = nativeImage.createFromBuffer(png);
        return readClipboardAttachment({
          clipboard: { ...snapshot, readImage: () => image }, store, sessionId, platform,
        });
      } catch (error) {
        return { status: 'error', error: error.attachmentCode || 'attachment-unavailable' };
      }
    })();
    const attempt = pending;
    void attempt.then(() => { if (pending === attempt) pending = null; });
    return attempt;
  };
}

module.exports = {
  createOwnedAttachmentStore, readClipboardAttachment, createClipboardAttachmentReader,
  parseDropFiles, registerAttachmentManagementIpc, LIMITS,
};
