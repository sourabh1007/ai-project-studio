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

test('Electron 44 async writes await rejection and verification instead of acknowledging a Promise', async () => {
  const { adaptClipboard } = require('../clipboard.cjs');
  let text = 'original';
  const clipboard = adaptClipboard({
    writeText: async (value) => { text = value; },
    readText: async () => text,
    read: async () => [{ types: ['text/plain'] }],
    clear: async () => { text = ''; },
  });
  assert.deepEqual(await writeClipboard(clipboard, true, 'copied'), { ok: true });
  clipboard.writeText = async () => { throw new Error('denied'); };
  assert.deepEqual(await writeClipboard(clipboard, true, 'private'),
    { ok: false, error: 'native-write-failed', writeState: 'unknown' });
  clipboard.writeText = async () => {};
  assert.equal((await writeClipboard(clipboard, true, 'different')).error, 'verification-failed');
  clipboard.readText = async () => { throw new Error('denied'); };
  assert.equal((await writeClipboard(clipboard, true, 'private')).error, 'verification-failed');
});

test('macOS copy and clear skip privacy-sensitive readback but still report async write denial', async () => {
  const handlers = {};
  let reject = false;
  const clipboard = {
    writeText: async () => { if (reject) throw new Error('denied'); },
    clear: async () => {},
    readText: () => assert.fail('copy must not request pasteboard access'),
    availableFormats: () => assert.fail('clear must not request pasteboard access'),
  };
  registerClipboardIpc({ handle: (name, fn) => { handlers[name] = fn; } }, clipboard, () => true, { platform: 'darwin' });
  assert.deepEqual(await handlers['clipboard:write']({}, 'copy'), { ok: true });
  assert.deepEqual(await handlers['clipboard:clear']({}), { ok: true });
  reject = true;
  assert.equal((await handlers['clipboard:write']({}, 'copy')).error, 'native-write-failed');
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
  assert.equal((await handlers['clipboard:write']({ trusted: false }, 'x')).error, 'untrusted');
});

test('transient native lock is retried with identical text; persistent failure stays explicit', async () => {
  const { writeClipboardWithRetry } = require('../clipboard.cjs');
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  const clipboard = fakeClipboard();
  const realWrite = clipboard.writeText.bind(clipboard);
  let failures = 2;
  clipboard.writeText = (value) => { if (failures-- > 0) throw new Error('busy'); realWrite(value); };
  assert.deepEqual(await writeClipboardWithRetry(clipboard, true, 'copied', sleep), { ok: true });
  assert.equal(clipboard.readText(), 'copied');
  assert.deepEqual(delays, [20, 60]);

  delays.length = 0;
  clipboard.writeText = () => { throw new Error('busy'); };
  assert.deepEqual(await writeClipboardWithRetry(clipboard, true, 'x', sleep),
    { ok: false, error: 'native-write-failed', writeState: 'unknown' });
  assert.deepEqual(delays, [20, 60]);

  delays.length = 0;
  assert.equal((await writeClipboardWithRetry(clipboard, false, 'x', sleep)).error, 'untrusted');
  assert.deepEqual(delays, []);
  assert.equal((await writeClipboardWithRetry(fakeClipboard(), true, 'x')).ok, true);
});

test('a retry sleeping in the main process never overwrites a newer write or clear', async () => {
  const setup = () => {
    const handlers = {};
    const clipboard = fakeClipboard();
    const realWrite = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (value) => {
      if (value === 'A' && clipboard.writes === 0) { clipboard.writes++; throw new Error('busy'); }
      realWrite(value);
    };
    registerClipboardIpc({ handle: (name, fn) => { handlers[name] = fn; } }, clipboard, () => true);
    return { handlers, clipboard };
  };

  let { handlers, clipboard } = setup();
  const a = handlers['clipboard:write']({}, 'A');
  assert.deepEqual(await handlers['clipboard:write']({}, 'B'), { ok: true });
  assert.deepEqual(await a, { ok: false, error: 'superseded', writeState: 'not-written' });
  assert.equal(clipboard.readText(), 'B');

  ({ handlers, clipboard } = setup());
  const stale = handlers['clipboard:write']({}, 'A');
  assert.deepEqual(await handlers['clipboard:clear']({}), { ok: true });
  assert.deepEqual(await stale, { ok: false, error: 'superseded', writeState: 'not-written' });
  assert.equal(clipboard.readText(), '');
  assert.deepEqual(clipboard.availableFormats(), []);

  ({ handlers, clipboard } = setup());
  const rejected = handlers['clipboard:write']({}, 'A');
  assert.equal((await handlers['clipboard:write']({}, '')).error, 'empty-text');
  assert.equal((await rejected).error, 'superseded');
  assert.equal(clipboard.readText(), 'original');

  ({ handlers, clipboard } = setup());
  assert.deepEqual(await handlers['clipboard:write']({}, 'A'), { ok: true });
  assert.equal(clipboard.readText(), 'A');
});

function editMenuFor(platform) {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  const menu = main.slice(main.indexOf('function installApplicationMenu()'), main.indexOf('const helpSubmenu'));
  let template;
  vm.runInNewContext(`${menu}\nreturn editSubmenu;\n}\nresult(installApplicationMenu());`, {
    process: { platform }, result: (items) => { template = items; },
  });
  return template;
}

test('macOS copy/paste use native editing roles and their Command key equivalents', () => {
  const template = editMenuFor('darwin');
  for (const role of ['copy', 'paste', 'pasteAndMatchStyle']) {
    const item = template.find((entry) => entry.role === role);
    assert.ok(item, `macOS requires the native ${role} role`);
    // Electron supplies the platform shortcut and focused native responder.
    // No custom click or second accelerator owner should dispatch another edit.
    assert.equal(item.click, undefined);
    assert.equal(item.accelerator, undefined);
    assert.equal(item.registerAccelerator, undefined);
  }
  assert.ok(template.some((entry) => entry.role === 'cut'));
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} copy/paste menu shortcuts do not register competing accelerator owners`, () => {
    const template = editMenuFor(platform);
    for (const label of ['Copy', 'Paste', 'Paste and Match Style']) {
      const item = template.find((entry) => entry.label === label);
      // No keyboard accelerator at all: the renderer owns Ctrl+C/V, so the menu
      // must not fire a second native edit command on the keystroke (the Windows
      // double-paste, electron/electron#18295).
      assert.equal(item.accelerator, undefined);
      assert.equal(item.role, undefined);
      let invoked = 0;
      const method = label === 'Copy' ? 'copy' : label === 'Paste' ? 'paste' : 'pasteAndMatchStyle';
      item.click(null, { webContents: { [method]: () => { invoked++; } } });
      assert.equal(invoked, 1);
    }
    assert.ok(template.some((entry) => entry.role === 'cut'));
  });
}

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

test('clipboard diagnostics restore async Electron 44 ClipboardItems without removed native methods', async () => {
  const { adaptClipboard } = require('../clipboard.cjs');
  class Item {
    constructor(values) { this.values = values; this.types = Object.keys(values); }
    async getType(type) { return this.values[type]; }
  }
  const initial = new Item({
    'text/plain': new Blob(['original']),
    'text/html': new Blob(['<b>original</b>']),
    'image/png': new Blob([Buffer.from('synthetic image payload')]),
  });
  let items = [initial];
  const native = {
    read: async () => items,
    readText: async () => items[0]?.values['text/plain']?.text() ?? '',
    writeText: async (text) => { items = [new Item({ 'text/plain': new Blob([text]) })]; },
    write: async (values) => { items = values; },
    clear: async () => { items = []; },
  };
  const clipboard = adaptClipboard(native, Item);
  const result = await runClipboardSmoke(clipboard, async () => {
    await clipboard.writeText(MARKER);
    return { baseline: true, cleared: true, final: true, results: [] };
  });
  assert.equal(result.status, 'passed');
  assert.equal(await native.readText(), 'original');
  assert.equal(await items[0].values['text/html'].text(), '<b>original</b>');
  assert.equal(await items[0].values['image/png'].text(), 'synthetic image payload');
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
