'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEYS = new Set(['cw-theme', 'cw-ui-prefs']);

function valid(key, value) {
  if (!KEYS.has(key) || typeof value !== 'string' || value.length > 8192) return false;
  if (key === 'cw-theme') return ['system', 'light', 'dark'].includes(value);
  try {
    const prefs = JSON.parse(value);
    return prefs !== null && typeof prefs === 'object' && !Array.isArray(prefs);
  } catch { return false; }
}

function createAppearanceStore(file, io = fs) {
  let values = {};
  let readError = null;
  try {
    const raw = JSON.parse(io.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.entries(raw).some(([key, value]) => !valid(key, value))) {
      throw new Error('Invalid saved appearance settings.');
    }
    values = raw;
  } catch (error) {
    if (error.code !== 'ENOENT') readError = error.message;
  }
  return {
    read: () => ({ values: { ...values }, error: readError }),
    save(key, value) {
      if (!valid(key, value)) return { saved: false, error: 'Invalid appearance setting.' };
      if (readError) return { saved: false, error: `Cannot safely update appearance settings: ${readError}` };
      const next = { ...values, [key]: value };
      const temporary = `${file}.tmp`;
      try {
        io.mkdirSync(path.dirname(file), { recursive: true });
        io.writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        io.renameSync(temporary, file);
        values = next;
        return { saved: true, error: null };
      } catch (error) {
        return { saved: false, error: error.message };
      }
    },
  };
}

function registerAppearanceIpc({ ipcMain, store, isTrustedSender, changed }) {
  ipcMain.on('appearance:get', (event) => {
    event.returnValue = isTrustedSender(event)
      ? store.read() : { values: {}, error: 'Untrusted appearance request.' };
  });
  ipcMain.on('appearance:save', (event, key, value) => {
    const result = isTrustedSender(event)
      ? store.save(key, value) : { saved: false, error: 'Untrusted appearance request.' };
    event.returnValue = result;
    if (result.saved) changed(key, value, event.sender);
  });
}

module.exports = { createAppearanceStore, registerAppearanceIpc };
