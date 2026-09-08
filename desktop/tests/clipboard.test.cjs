'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { writeClipboard, registerClipboardIpc, MAX_CLIPBOARD_LENGTH } = require('../clipboard.cjs');
const { isBoundedString, isClipboardText } = require('../ipc-input.cjs');
const { runClipboardSmoke, clipboardScenario, MARKER } = require('../regression-clipboard.cjs');

function fakeClipboard() {
  let text = 'original';
  let formats = ['text/plain'];
  return {
    writes: 0, clears: 0,
    writeText(value) { this.writes++; text = value; formats = ['text/plain']; },
    readText: () => text,
    availableFormats: () => formats,
    clear() { this.clears++; text = ''; formats = []; },
    write(value) { text = value.text; formats = ['text/plain']; },
  };
}

test('clipboard-specific size budget accepts historical boundaries and 1Mi text, including UTF16', () => {
  const clipboard = fakeClipboard();
  for (const size of [32768, 32769, 65536, 1024 * 1024, MAX_CLIPBOARD_LENGTH]) {
    const text = '😀\r\n' + 'x'.repeat(size - 4);
    assert.deepEqual(writeClipboard(clipboard, true, text), { ok: true });
    assert.equal(clipboard.readText(), text);
  }
  assert.equal(isBoundedString('x'.repeat(32769)), false);
  assert.equal(isClipboardText('😀'.repeat(MAX_CLIPBOARD_LENGTH / 2)), true);
  assert.equal(isClipboardText('😀'.repeat(MAX_CLIPBOARD_LENGTH / 2 + 1)), false);
});

test('rejections are explicit, preserve old content, and empty copy is not clear', () => {
  const clipboard = fakeClipboard();
  for (const [trusted, text, error] of [
    [false, 'secret', 'untrusted'], [true, 12, 'invalid-text'],
    [true, '', 'empty-text'], [true, 'x'.repeat(MAX_CLIPBOARD_LENGTH + 1), 'too-large'],
  ]) {
    assert.deepEqual(writeClipboard(clipboard, trusted, text),
      { ok: false, error, writeState: 'not-written' });
    assert.equal(clipboard.readText(), 'original');
    assert.equal(clipboard.writes, 0);
  }
  assert.equal(writeClipboard(clipboard, false, undefined, true).ok, false);
  assert.deepEqual(writeClipboard(clipboard, true, undefined, true), { ok: true });
  assert.equal(clipboard.clears, 1);
  assert.equal(clipboard.readText(), '');
});

test('native exceptions and verification failures never claim pre-write safety', () => {
  const clipboard = fakeClipboard();
  clipboard.writeText = () => { throw new Error('OS busy'); };
  assert.equal(writeClipboard(clipboard, true, 'x').writeState, 'unknown');
  clipboard.writeText = () => {};
  assert.equal(writeClipboard(clipboard, true, 'x').writeState, 'written');
  clipboard.readText = () => { throw new Error('read unavailable'); };
  assert.equal(writeClipboard(clipboard, true, 'x').writeState, 'written');
  clipboard.clear = () => { throw new Error('OS busy'); };
  assert.equal(writeClipboard(clipboard, true, undefined, true).writeState, 'unknown');
  clipboard.clear = () => {};
  assert.equal(writeClipboard(clipboard, true, undefined, true).writeState, 'written');
});

test('real preload uses invoke for copy/clear and propagates the main acknowledgement', async () => {
  const handlers = {};
  const clipboard = fakeClipboard();
  registerClipboardIpc({ handle: (name, fn) => { handlers[name] = fn; } }, clipboard, (e) => e.trusted);
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_, api) => { bridge = api; } },
      ipcRenderer: { invoke: async (name, ...args) => handlers[name]({ trusted: true }, ...args),
        send() { assert.fail('clipboard must not send'); } },
    }),
  });

  assert.deepEqual(await bridge.copyText('x'.repeat(32769)), { ok: true });
  assert.equal((await bridge.copyText('')).error, 'empty-text');
  assert.deepEqual(await bridge.clearClipboard(), { ok: true });
  assert.equal(handlers['clipboard:write']({ trusted: false }, 'x').error, 'untrusted');
});

test('copy/paste menu shortcuts do not register competing accelerator owners', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const menu = main.slice(main.indexOf('function installApplicationMenu()'), main.indexOf('const helpSubmenu'));
  let template;
  vm.runInNewContext(`${menu}\nreturn editSubmenu;\n}\nresult(installApplicationMenu());`, {
    process: { platform: 'win32' }, result: (items) => { template = items; },
  });
  for (const label of ['Copy', 'Paste', 'Paste and Match Style']) {
    const item = template.find((entry) => entry.label === label);
    assert.equal(item.registerAccelerator, false);
    let invoked = 0;
    const method = label === 'Copy' ? 'copy' : label === 'Paste' ? 'paste' : 'pasteAndMatchStyle';
    item.click(null, { webContents: { [method]: () => { invoked++; } } });
    assert.equal(invoked, 1);
  }
  assert.ok(template.some((entry) => entry.role === 'cut'));
});

test('packaged smoke scenario traverses copy/read/clear and restores a supported clipboard', async () => {
  const clipboard = fakeClipboard();
  const writeText = clipboard.writeText.bind(clipboard);
  clipboard.writeText = (text) => writeText(Buffer.from(text, 'utf8').toString('utf8'));
  const evaluate = (expression) => vm.runInNewContext(expression, {
    window: { desktop: {
      copyText: async (text) => writeClipboard(clipboard, true, text),
      clearClipboard: async () => writeClipboard(clipboard, true, undefined, true),
      readText: async () => clipboard.readText(),
    } },
  });
  const result = await runClipboardSmoke(clipboard, evaluate);
  assert.equal(result.status, 'passed');
  assert.deepEqual(Array.from(result.outcome.results.filter((item) => !item.name), (item) => item.length),
    [32768, 32769, 65536, 1024 * 1024, MAX_CLIPBOARD_LENGTH]);
  assert.ok(result.outcome.results.filter((item) => !item.name).every((item) => item.matches));
  assert.equal(result.restoration, 'passed');
  assert.equal(clipboard.readText(), 'original');
  assert.equal(JSON.stringify(result).includes('original'), false);
});

test('smoke refuses custom clipboard formats without mutation or renderer evaluation', async () => {
  const clipboard = fakeClipboard();
  clipboard.availableFormats = () => ['application/custom'];
  assert.equal((await runClipboardSmoke(clipboard, () => assert.fail())).status, 'unsupported');
  assert.equal(clipboard.writes, 0);
});

test('smoke does not overwrite a new user clipboard, reports failed restoration and native rejection', async () => {
  const clipboard = fakeClipboard();
  const lost = await runClipboardSmoke(clipboard, async () => { throw new Error('renderer gone'); });
  assert.equal(lost.restoration, 'skipped-ownership-lost');
  assert.equal(clipboard.readText(), 'original');
  const outcome = { baseline: true, cleared: true, final: true, results: [{ name: 'empty', rejected: false }] };
  const failed = await runClipboardSmoke(clipboard, async () => {
    clipboard.writeText(MARKER);
    clipboard.write = () => { throw new Error('locked'); };
    return outcome;
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.restoration, 'failed');
  assert.equal(typeof clipboardScenario, 'function');
});
