'use strict';

const { isClipboardText, MAX_CLIPBOARD_LENGTH } = require('./ipc-input.cjs');

const failure = (error, writeState = 'not-written') => ({ ok: false, error, writeState });

/** A thrown native call may already have mutated the OS clipboard. Never retry it. */
function writeClipboard(clipboard, trusted, text, clear = false) {
  if (!trusted) return failure('untrusted');
  if (!clear && !isClipboardText(text)) {
    return failure(typeof text !== 'string' ? 'invalid-text'
      : text.length === 0 ? 'empty-text'
        : 'too-large');
  }
  try {
    if (clear) clipboard.clear();
    else clipboard.writeText(text);
  } catch {
    return failure('native-write-failed', 'unknown');
  }
  try {
    const verified = clear
      ? clipboard.availableFormats().length === 0
      : clipboard.readText() === text;
    return verified ? { ok: true } : failure('verification-failed', 'written');
  } catch {
    return failure('verification-failed', 'written');
  }
}

function registerClipboardIpc(ipcMain, clipboard, isTrustedSender) {
  ipcMain.handle('clipboard:write', (event, text) =>
    writeClipboard(clipboard, isTrustedSender(event), text));
  ipcMain.handle('clipboard:clear', (event) =>
    writeClipboard(clipboard, isTrustedSender(event), undefined, true));
}

module.exports = { writeClipboard, registerClipboardIpc, MAX_CLIPBOARD_LENGTH };
