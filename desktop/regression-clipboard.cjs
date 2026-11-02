'use strict';

const { MAX_CLIPBOARD_LENGTH } = require('./ipc-input.cjs');

const MARKER = 'AI-Project-Studio clipboard fixture';

// Runs in the isolated synthetic document, but uses the production preload IPC.
async function clipboardScenario(limit, marker) {
  const results = [];
  const bridge = window.desktop;
  const pattern = '😀\r\n' + 'x'.repeat(12);
  for (const length of [32768, 32769, 65536, 1024 * 1024, limit]) {
    const text = pattern.repeat(Math.floor(length / pattern.length)) + 'x'.repeat(length % pattern.length);
    const result = await bridge.copyText(text);
    const matches = result.ok && await bridge.readText() === text;
    results.push({ length, acknowledged: result.ok === true, matches });
  }
  const baseline = await bridge.copyText(marker);
  for (const [name, text] of [['over-limit', 'x'.repeat(limit + 1)], ['empty', '']]) {
    const result = await bridge.copyText(text);
    results.push({ name, rejected: result.ok === false && result.writeState === 'not-written',
      error: result.error, unchanged: await bridge.readText() === marker });
  }
  const clear = await bridge.clearClipboard();
  const cleared = clear.ok && await bridge.readText() === '';
  const final = await bridge.copyText(marker);
  return { results, baseline: baseline.ok === true, cleared, final: final.ok === true };
}

async function runClipboardSmoke(clipboard, evaluate) {
  const formats = await clipboard.availableFormats();
  const supported = ['text/plain', 'text/html', 'text/rtf', 'image/png'];
  // File/custom formats cannot safely be reconstructed through Electron.write.
  if (formats.some((format) => !supported.includes(format))) {
    return { status: 'unsupported', reason: 'Clipboard has non-restorable formats; no mutation performed' };
  }
  const saved = {};
  if (formats.includes('text/plain')) saved.text = await clipboard.readText();
  if (formats.includes('text/html')) saved.html = await clipboard.readHTML();
  if (formats.includes('text/rtf')) saved.rtf = await clipboard.readRTF();
  if (formats.includes('image/png')) {
    if (clipboard.readPng) saved.png = await clipboard.readPng();
    else saved.image = clipboard.readImage();
  }
  let outcome;
  let restoration = 'not-attempted';
  try {
    outcome = await evaluate(`(${clipboardScenario.toString()})(${MAX_CLIPBOARD_LENGTH}, ${JSON.stringify(MARKER)})`);
  } catch {
    outcome = { error: 'Packaged clipboard scenario interrupted' };
  } finally {
    // Do not overwrite an intervening user's clipboard. An interrupted scenario
    // may leave test data behind: report it, never guess ownership.
    if (await clipboard.readText() !== MARKER) {
      restoration = 'skipped-ownership-lost';
    } else {
      try {
        if (formats.length) await clipboard.write(saved);
        else await clipboard.clear();
        const restoredFormats = await clipboard.availableFormats();
        const matched = formats.length === restoredFormats.length &&
          formats.every((format) => restoredFormats.includes(format)) &&
          (!('text' in saved) || await clipboard.readText() === saved.text) &&
          (!('html' in saved) || await clipboard.readHTML() === saved.html) &&
          (!('rtf' in saved) || await clipboard.readRTF() === saved.rtf) &&
          (!saved.png || (await clipboard.readPng()).equals(saved.png)) &&
          (!saved.image || clipboard.readImage().toPNG().equals(saved.image.toPNG()));
        restoration = matched ? 'passed' : 'failed';
      } catch {
        restoration = 'failed';
      }
    }
  }
  const passed = outcome?.baseline && outcome.cleared && outcome.final &&
    outcome.results.every((item) => item.name
      ? item.rejected && item.unchanged &&
        item.error === (item.name === 'empty' ? 'empty-text' : 'too-large')
      : item.acknowledged && item.matches);
  return { status: passed && restoration === 'passed' ? 'passed' : 'failed', restoration, outcome };
}

module.exports = { runClipboardSmoke, clipboardScenario, MARKER };
