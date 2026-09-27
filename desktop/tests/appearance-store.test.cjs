'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAppearanceStore, registerAppearanceIpc } = require('../appearance-store.cjs');

test('appearance survives a fresh process store without depending on backend port', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-appearance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'appearance.json');
  const first = createAppearanceStore(file);
  assert.deepEqual(first.read(), { values: {}, error: null });
  const prefs = JSON.stringify({ accent: '#123456', font: 'reading', density: 'comfortable',
    radius: 'round', textSize: 'large', motion: 'off', terminalFont: 'fira-code',
    terminalTextSize: 'x-large', terminalTextColor: '#abcdef' });
  assert.equal(first.save('cw-ui-prefs', prefs).saved, true);
  assert.equal(first.save('cw-theme', 'system').saved, true);
  assert.deepEqual(createAppearanceStore(file).read(), {
    values: { 'cw-ui-prefs': prefs, 'cw-theme': 'system' }, error: null,
  });
  assert.equal(first.save('arbitrary-file', 'secret').saved, false);
  assert.equal(first.save('cw-theme', 'unknown').saved, false);
  for (const value of ['null', '[]', 'invalid', 'x'.repeat(8193)]) {
    assert.equal(first.save('cw-ui-prefs', value).saved, false);
  }
  const brokenIo = { ...fs, renameSync() { throw new Error('Disk denied'); } };
  const broken = createAppearanceStore(file, brokenIo);
  assert.deepEqual(broken.save('cw-theme', 'light'), { saved: false, error: 'Disk denied' });
  assert.equal(createAppearanceStore(file).read().values['cw-theme'], 'system');
  fs.writeFileSync(file, '{broken');
  const corrupt = createAppearanceStore(file);
  assert.ok(corrupt.read().error);
  assert.equal(corrupt.save('cw-theme', 'dark').saved, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('appearance IPC rejects untrusted requests and acknowledges durable writes before notifying windows', () => {
  const ipcMain = new EventEmitter();
  const changed = [];
  const store = {
    read: () => ({ values: { 'cw-theme': 'dark' }, error: null }),
    save: (key, value) => ({ saved: key === 'cw-theme' && value === 'light', error: null }),
  };
  registerAppearanceIpc({ ipcMain, store, isTrustedSender: (event) => event.trusted,
    changed: (...args) => changed.push(args) });
  const event = { trusted: false, sender: 'window' };
  ipcMain.emit('appearance:get', event);
  assert.ok(event.returnValue.error);
  ipcMain.emit('appearance:save', event, 'cw-theme', 'light');
  assert.equal(event.returnValue.saved, false);
  assert.equal(changed.length, 0);
  event.trusted = true;
  ipcMain.emit('appearance:get', event);
  assert.equal(event.returnValue.values['cw-theme'], 'dark');
  ipcMain.emit('appearance:save', event, 'cw-theme', 'light');
  assert.equal(event.returnValue.saved, true);
  assert.deepEqual(changed, [['cw-theme', 'light', 'window']]);
});
