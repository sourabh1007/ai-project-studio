'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const attachments = require('../owned-attachments.cjs');

function fixture(t, options = {}) {
  const root = path.resolve(__dirname, '..', 'test-results', `attachments-${randomUUID()}`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: attachments.createOwnedAttachmentStore({ root, ...options }) };
}
function imageClipboard({ width = 20, height = 20, png = Buffer.from('png') } = {}) {
  const image = {
    encodes: 0, isEmpty: () => false, getSize: () => ({ width, height }),
    toPNG(options) { assert.equal(options.scaleFactor, 1); this.encodes++; return png; },
  };
  return { image, has: () => false, readImage: () => image };
}
const smallLimits = { ...attachments.LIMITS, fileBytes: 16, totalBytes: 24, files: 2 };

test('session-bound exclusive identities are unique and remain counted after restart', (t) => {
  const { root, store } = fixture(t, { limits: smallLimits });
  const a = store.save('session-a', Buffer.alloc(12));
  const b = store.save('session-b', Buffer.alloc(12));
  assert.notEqual(a.attachmentId, b.attachmentId);
  assert.equal(a.sessionId, 'session-a');
  assert.equal(fs.statSync(a.paths[0]).size, 12);
  const restarted = attachments.createOwnedAttachmentStore({ root, limits: smallLimits });
  assert.throws(() => restarted.save('session-c', Buffer.from('x')), /quota/);
  assert.equal(restarted.releaseConfirmedUnused('session-a', a.attachmentId), false);
  assert.equal(fs.existsSync(a.paths[0]), true);
});

test('count, total and individual byte limits fail explicitly without deleting existing attachments', (t) => {
  const { root, store } = fixture(t, { limits: smallLimits });
  const a = store.save('s1', Buffer.alloc(16));
  assert.throws(() => store.save('s1', Buffer.alloc(17)), /image-too-large/);
  assert.throws(() => store.save('s1', Buffer.alloc(9)), /quota/);
  const b = store.save('s1', Buffer.alloc(8));
  assert.throws(() => store.save('s1', Buffer.from('x')), /quota/);
  assert.deepEqual(fs.readdirSync(root).sort(), [path.basename(a.paths[0]), path.basename(b.paths[0])].sort());
});

test('cleanup requires a current issued lease and matching session, never a discovered file index', (t) => {
  const { root, store } = fixture(t);
  const lease = store.save('s1', Buffer.from('keep'));
  assert.equal(store.releaseConfirmedUnused('other-session', lease.attachmentId), false);
  assert.equal(store.releaseConfirmedUnused('s1', 'unissued'), false);
  assert.equal(fs.readFileSync(lease.paths[0], 'utf8'), 'keep');
  assert.equal(store.releaseConfirmedUnused('s1', lease.attachmentId), true);
  assert.equal(store.releaseConfirmedUnused('s1', lease.attachmentId), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('manual selection works across restart and recovers full storage without deleting other files', (t) => {
  const { root, store } = fixture(t, { limits: smallLimits });
  const first = store.save('s1', Buffer.alloc(12));
  const second = store.save('s2', Buffer.alloc(12));
  const restarted = attachments.createOwnedAttachmentStore({ root, limits: smallLimits });
  const listed = restarted.list();
  assert.equal(listed.status, 'ready');
  assert.equal(listed.totalBytes, 24);
  assert.equal(listed.limits.files, 2);
  const selected = listed.items.find((item) => item.name === path.basename(first.paths[0]));
  assert.equal(selected.bytes, 12);
  assert.ok(Number.isFinite(Date.parse(selected.createdAt)));
  assert.deepEqual(restarted.describeRemoval([selected.id]), { count: 1, bytes: 12 });
  assert.deepEqual(restarted.removeSelected([selected.id]), { status: 'deleted', deleted: 1 });
  assert.equal(fs.existsSync(first.paths[0]), false);
  assert.equal(fs.existsSync(second.paths[0]), true);
  assert.equal(restarted.save('s3', Buffer.alloc(12)).status, 'ready');
});

test('manual removal also frees the current process lease quota', (t) => {
  const { store } = fixture(t, { limits: smallLimits });
  store.save('s1', Buffer.alloc(12)); store.save('s2', Buffer.alloc(12));
  const listed = store.list();
  store.removeSelected(listed.items.map((item) => item.id));
  assert.equal(store.save('s3', Buffer.alloc(12)).status, 'ready');
  assert.equal(store.save('s4', Buffer.alloc(12)).status, 'ready');
});

test('manual selection remains available when retained files exceed the byte quota', (t) => {
  const { store } = fixture(t, { limits: smallLimits });
  const saved = store.save('s1', Buffer.from('x'));
  fs.writeFileSync(saved.paths[0], Buffer.alloc(32));
  assert.throws(() => store.assertCapacity(), /quota/);
  const listed = store.list();
  assert.equal(listed.totalBytes, 32);
  assert.equal(store.removeSelected([listed.items[0].id]).deleted, 1);
  assert.equal(store.save('s2', Buffer.from('x')).status, 'ready');
});

test('manual cleanup rejects arbitrary paths, duplicate IDs and stale snapshots', (t) => {
  const { store } = fixture(t);
  const saved = store.save('s1', Buffer.from('retain'));
  const first = store.list().items[0];
  for (const ids of [undefined, [], [saved.paths[0]], ['../other'], [first.id, first.id]]) {
    assert.throws(() => store.removeSelected(ids), /invalid-selection/);
  }
  store.list();
  assert.throws(() => store.removeSelected([first.id]), /invalid-selection/);
  assert.equal(fs.readFileSync(saved.paths[0], 'utf8'), 'retain');
});

test('manual cleanup validates the entire selection before deleting any changed or linked file', (t) => {
  const { root, store } = fixture(t);
  const a = store.save('s1', Buffer.from('a'));
  const b = store.save('s2', Buffer.from('b'));
  const ids = store.list().items.map((item) => item.id);
  fs.writeFileSync(b.paths[0], 'changed');
  assert.throws(() => store.removeSelected(ids), /stale-selection/);
  assert.equal(fs.readFileSync(a.paths[0], 'utf8'), 'a');
  const fresh = store.list();
  const selected = fresh.items.find((item) => item.name === path.basename(b.paths[0]));
  const linked = path.join(root, 'outside.txt');
  fs.linkSync(b.paths[0], linked);
  assert.throws(() => store.removeSelected([selected.id]), /stale-selection/);
  assert.equal(fs.readFileSync(linked, 'utf8'), 'changed');
});

test('manual cleanup surfaces partial failure accurately and retains the remaining selection', (t) => {
  let removals = 0;
  const io = { ...fs, unlinkSync(file) {
    if (++removals === 2) throw new Error('private busy path');
    fs.unlinkSync(file);
  } };
  const { root, store } = fixture(t, { io });
  store.save('s1', Buffer.from('one')); store.save('s2', Buffer.from('two'));
  const ids = store.list().items.map((item) => item.id);
  assert.throws(() => store.removeSelected(ids), (error) => {
    assert.equal(error.attachmentCode, 'attachment-unavailable');
    assert.equal(error.deleted, 1);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  assert.equal(fs.readdirSync(root).length, 1);
  assert.deepEqual(store.removeSelected([ids[1]]), { status: 'deleted', deleted: 1 });
});

test('manual IPC requires trusted sender, fresh selection and affirmative confirmation', async (t) => {
  const { store } = fixture(t);
  const handlers = {};
  let approve = false;
  let confirmations = 0;
  attachments.registerAttachmentManagementIpc({
    ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
    isTrustedSender: (event) => event.trusted,
    getStore: () => store,
    confirmRemoval: async ({ count }) => { assert.equal(count, 1); confirmations++; return approve; },
  });
  const event = { trusted: true };
  const saved = store.save('s1', Buffer.from('keep'));
  const listed = handlers['attachments:list'](event);
  const ids = listed.items.map((item) => item.id);
  assert.equal(handlers['attachments:list']({ trusted: false }).error, 'untrusted');
  assert.equal((await handlers['attachments:remove']({ trusted: false }, { ids })).error, 'untrusted');
  assert.equal(confirmations, 0);
  assert.deepEqual(await handlers['attachments:remove'](event, { ids }), { status: 'cancelled' });
  assert.equal(fs.existsSync(saved.paths[0]), true);
  approve = true;
  assert.deepEqual(await handlers['attachments:remove'](event, { ids }), { status: 'deleted', deleted: 1 });
  assert.equal((await handlers['attachments:remove'](event, { ids })).error, 'invalid-selection');
  assert.equal(confirmations, 2);
});

test('manual IPC rechecks sender and selection after the confirmation dialog', async (t) => {
  const { store } = fixture(t);
  const handlers = {};
  const event = { trusted: true };
  let duringConfirmation = () => { event.trusted = false; };
  attachments.registerAttachmentManagementIpc({
    ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
    isTrustedSender: (value) => value.trusted, getStore: () => store,
    confirmRemoval: async () => { duringConfirmation(); return true; },
  });
  const saved = store.save('s1', Buffer.from('keep'));
  let ids = store.list().items.map((item) => item.id);
  assert.equal((await handlers['attachments:remove'](event, { ids })).error, 'untrusted');
  event.trusted = true;
  ids = store.list().items.map((item) => item.id);
  duringConfirmation = () => { store.list(); };
  assert.equal((await handlers['attachments:remove'](event, { ids })).error, 'invalid-selection');
  assert.equal(fs.existsSync(saved.paths[0]), true);
});

test('collisions cannot overwrite attachments and traversal cannot choose a filename', (t) => {
  const { root, store } = fixture(t, { randomId: () => 'a'.repeat(32) });
  const first = store.save('s1', Buffer.from('original'));
  assert.throws(() => store.save('s1', Buffer.from('overwrite')), /collision/);
  assert.throws(() => store.save('../source', Buffer.from('x')), /invalid-session/);
  assert.equal(fs.readFileSync(first.paths[0], 'utf8'), 'original');
  const restarted = attachments.createOwnedAttachmentStore({ root, randomId: () => 'a'.repeat(32) });
  assert.throws(() => restarted.save('s1', Buffer.from('overwrite')), /collision/);
  assert.equal(fs.readFileSync(first.paths[0], 'utf8'), 'original');
});

test('replaced/hardlinked identities and unknown files fail closed without deleting sources', (t) => {
  const { root, store } = fixture(t);
  const lease = store.save('s1', Buffer.from('original'));
  const source = path.join(root, 'source.txt');
  fs.writeFileSync(source, 'external');
  fs.unlinkSync(lease.paths[0]);
  fs.linkSync(source, lease.paths[0]);
  assert.throws(() => store.releaseConfirmedUnused('s1', lease.attachmentId), /unsafe-storage/);
  assert.throws(() => store.save('s1', Buffer.from('x')), /unsafe-storage/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'external');
});

test('symlinked or redirected store directories are rejected before writing', (t) => {
  const { root } = fixture(t);
  const io = { ...fs, realpathSync: () => root + '-redirected' };
  const store = attachments.createOwnedAttachmentStore({ root, io });
  assert.throws(() => store.save('s1', Buffer.from('x')), /unsafe-storage/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a partial write is cleaned only by its created identity and never returned as ready', (t) => {
  const io = { ...fs, writeFileSync(fd, data) {
    fs.writeSync(fd, data.subarray(0, 1));
    throw new Error('private disk path');
  } };
  const { root, store } = fixture(t, { io });
  const result = attachments.readClipboardAttachment({ clipboard: imageClipboard(), store, sessionId: 's1' });
  assert.deepEqual(result, { status: 'error', error: 'attachment-unavailable' });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('native dimensions and quota reject before PNG encoding; encoded-byte limit rejects before write', (t) => {
  const { root, store } = fixture(t, { limits: smallLimits });
  const huge = imageClipboard({ width: 100000 });
  assert.equal(attachments.readClipboardAttachment({ clipboard: huge, store, sessionId: 's1' }).error, 'image-too-large');
  assert.equal(huge.image.encodes, 0);
  const encoded = imageClipboard({ png: Buffer.alloc(17) });
  assert.equal(attachments.readClipboardAttachment({ clipboard: encoded, store, sessionId: 's1' }).error, 'image-too-large');
  assert.deepEqual(fs.readdirSync(root), []);
  store.save('s1', Buffer.alloc(12));
  store.save('s1', Buffer.alloc(12));
  const full = imageClipboard();
  assert.equal(attachments.readClipboardAttachment({ clipboard: full, store, sessionId: 's1' }).error, 'quota');
  assert.equal(full.image.encodes, 0);
});

test('Explorer source paths remain structured, never acquire a lease or touch owned storage', (t) => {
  const { root, store } = fixture(t);
  const clipboard = {
    has: (format) => format === 'FileNameW',
    readBuffer: () => Buffer.from('C:\\source folder\\a.png\0C:\\other\\b.txt\0', 'utf16le'),
    readImage: () => assert.fail('file clipboard must not encode an image'),
  };
  assert.deepEqual(attachments.readClipboardAttachment({ clipboard, store, sessionId: 's1', platform: 'win32' }), {
    status: 'ready', source: 'clipboard-files', paths: ['C:\\source folder\\a.png', 'C:\\other\\b.txt'],
  });
  assert.equal(fs.existsSync(root), false);
});

test('URI clipboard decoding preserves escaped paths and rejects unsupported/truncated clipboard data', (t) => {
  const { root, store } = fixture(t);
  const clipboard = { has: (format) => format === 'text/uri-list', read: () => 'https://example.com/a' };
  assert.equal(attachments.readClipboardAttachment({ clipboard, store, sessionId: 's1' }).status, 'error');
  const source = path.join(root, 'source with % spaces.png');
  clipboard.read = () => pathToFileURL(source).href;
  assert.deepEqual(attachments.readClipboardAttachment({ clipboard, store, sessionId: 's1' }), {
    status: 'ready', source: 'clipboard-files', paths: [source],
  });
  const bad = { has: () => true, readBuffer: () => Buffer.from([1]) };
  assert.equal(attachments.readClipboardAttachment({ clipboard: bad, store, sessionId: 's1', platform: 'win32' }).error, 'invalid-paths');
  const empty = imageClipboard();
  empty.image.isEmpty = () => true;
  assert.deepEqual(attachments.readClipboardAttachment({ clipboard: empty, store, sessionId: 's1' }), { status: 'none' });
});

test('production main image handler and preload carry session context, structured result and explicit refusal', async (t) => {
  const { root } = fixture(t);
  const handlers = {};
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const handler = main.slice(main.indexOf('  const getAttachmentStore ='), main.indexOf('  applyContentSecurityPolicy();'));
  let response = { response: 1, checkboxChecked: false };
  let confirmationOptions;
  vm.runInNewContext(`let clipboardAttachmentStore = null;\n${handler}`, {
    ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
    isTrustedSender: (event) => event.trusted, clipboard: imageClipboard(), path,
    app: { getPath: () => root }, require: () => attachments,
    dialog: { showMessageBox: async (options) => { confirmationOptions = options; return response; } },
  });
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: (name, request) => handlers[name]({ trusted: true }, request) },
    }),
  });
  assert.equal(handlers['clipboard:readImage']({ trusted: false }, { sessionId: 's1' }).error, 'untrusted');
  assert.equal((await bridge.readImage({ sessionId: '../bad' })).error, 'invalid-session');
  const result = await bridge.readImage({ sessionId: 's1' });
  assert.equal(result.status, 'ready');
  assert.equal(result.sessionId, 's1');
  assert.equal(result.paths.length, 1);
  assert.equal(fs.readFileSync(result.paths[0], 'utf8'), 'png');
  const listed = await bridge.attachments.list();
  assert.equal(listed.items.length, 1);
  const ids = listed.items.map((item) => item.id);
  assert.equal((await bridge.attachments.remove({ ids })).status, 'cancelled');
  assert.equal(fs.existsSync(result.paths[0]), true);
  assert.equal(confirmationOptions.defaultId, 0);
  assert.equal(confirmationOptions.cancelId, 0);
  assert.equal(confirmationOptions.checkboxChecked, false);
  assert.match(confirmationOptions.detail, /resumed prompts/);
  response = { response: 1, checkboxChecked: true };
  assert.equal((await bridge.attachments.remove({ ids })).status, 'deleted');
  assert.equal(fs.existsSync(result.paths[0]), false);
});
