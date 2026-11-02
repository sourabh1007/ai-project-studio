'use strict';

const { isClipboardText, MAX_CLIPBOARD_LENGTH } = require('./ipc-input.cjs');

const failure = (error, writeState = 'not-written') => ({ ok: false, error, writeState });
const settle = (value, success, failed) => {
  if (value && typeof value.then === 'function') return value.then(success, failed);
  return success(value);
};

/** A rejected native call may already have mutated the OS clipboard. */
function writeClipboard(clipboard, trusted, text, clear = false, { verify = true } = {}) {
  if (!trusted) return failure('untrusted');
  if (!clear && !isClipboardText(text)) {
    return failure(typeof text !== 'string' ? 'invalid-text'
      : text.length === 0 ? 'empty-text'
        : 'too-large');
  }
  try {
    const written = clear ? clipboard.clear() : clipboard.writeText(text);
    return settle(written, () => {
      // macOS may deny programmatic reads independently of a successful write.
      // Do not trigger an unrelated pasteboard privacy read just to verify copy.
      if (!verify) return { ok: true };
      try {
        return settle(clear ? clipboard.availableFormats() : clipboard.readText(), (value) => {
          const verified = clear ? value.length === 0 : value === text;
          return verified ? { ok: true } : failure('verification-failed', 'written');
        }, () => failure('verification-failed', 'written'));
      } catch {
        return failure('verification-failed', 'written');
      }
    }, () => failure('native-write-failed', 'unknown'));
  } catch {
    return failure('native-write-failed', 'unknown');
  }
}

const RETRY_DELAYS_MS = [20, 60];
const RETRYABLE = new Set(['native-write-failed', 'verification-failed']);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Another process (clipboard manager, remote-desktop sync) can briefly hold the
 * OS clipboard so the first write throws or does not verify. Rewriting the same
 * text is idempotent, so retry a bounded number of times; the final failure is
 * reported as-is and never presented as success.
 */
async function writeClipboardWithRetry(clipboard, trusted, text, sleep = pause, isCurrent = () => true, options) {
  if (!isCurrent()) return superseded();
  let result = await writeClipboard(clipboard, trusted, text, false, options);
  for (const delay of RETRY_DELAYS_MS) {
    if (result.ok || !RETRYABLE.has(result.error)) break;
    await sleep(delay);
    // A newer write or clear owns the clipboard now; never overwrite or restore over it.
    if (!isCurrent()) return superseded();
    result = await writeClipboard(clipboard, trusted, text, false, options);
  }
  return result;
}

/** The superseded write's earlier attempt was replaced by the newer operation, so nothing of it is retained. */
const superseded = () => failure('superseded');

function registerClipboardIpc(ipcMain, clipboard, isTrustedSender, { platform = process.platform } = {}) {
  // Incremented by every write and clear, valid or not, so any later operation cancels pending retries.
  let epoch = 0;
  let tail = Promise.resolve();
  const enqueue = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  ipcMain.handle('clipboard:write', (event, text) => {
    const mine = ++epoch;
    const trusted = isTrustedSender(event);
    return enqueue(() => writeClipboardWithRetry(clipboard, trusted, text, pause, () => mine === epoch,
      { verify: platform !== 'darwin' }));
  });
  ipcMain.handle('clipboard:clear', (event) => {
    epoch += 1;
    const trusted = isTrustedSender(event);
    return enqueue(() => writeClipboard(clipboard, trusted, undefined, true, { verify: platform !== 'darwin' }));
  });
}

/** Electron 44 uses ClipboardItems instead of the removed sync format helpers. */
function adaptClipboard(clipboard, ClipboardItem) {
  if (typeof clipboard.availableFormats === 'function') return clipboard;
  const textType = { text: 'text/plain', html: 'text/html', rtf: 'text/rtf' };
  const readType = async (type) => {
    const item = (await clipboard.read()).find((value) => value.types.includes(type));
    return item ? item.getType(type) : null;
  };
  return {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
    clear: () => clipboard.clear(),
    availableFormats: async () => [...new Set((await clipboard.read()).flatMap((item) => item.types))],
    readHTML: async () => (await readType('text/html'))?.text() ?? '',
    readRTF: async () => (await readType('text/rtf'))?.text() ?? '',
    readPng: async () => {
      const blob = await readType('image/png');
      return blob ? Buffer.from(await blob.arrayBuffer()) : null;
    },
    write: async (saved) => {
      const values = {};
      for (const [key, type] of Object.entries(textType)) {
        if (key in saved) values[type] = new Blob([saved[key]], { type });
      }
      if (saved.png) values['image/png'] = new Blob([saved.png], { type: 'image/png' });
      await clipboard.write([new ClipboardItem(values)]);
    },
  };
}

module.exports = { writeClipboard, writeClipboardWithRetry, registerClipboardIpc, adaptClipboard, MAX_CLIPBOARD_LENGTH };
