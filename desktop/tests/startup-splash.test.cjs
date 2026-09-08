'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');
const { createStartupSplash } = require('../startup-splash.cjs');

const desktop = path.join(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, { loadError } = {}) {
  const ipcMain = new EventEmitter();
  const states = [];
  let closes = 0;
  let allowed = false;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.shows = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, send: (_channel, state) => states.push(state),
        setWindowOpenHandler: (handler) => { this.open = handler; },
      });
    }
    loadFile(file) { this.file = file; return loadError ? Promise.reject(loadError) : Promise.resolve(); }
    show() { this.shows++; }
    destroy() { this.emit('closed'); }
  }
  const splash = createStartupSplash({
    BrowserWindow: Window, ipcMain, icon: 'icon', theme: 'dark', version: '0.11.0',
    canClose: () => allowed, onClose: () => { closes++; },
  });
  t.after(() => splash.window.destroy());
  return {
    splash, ipcMain, states, closes: () => closes, allowClose: () => { allowed = true; },
    async ready() {
      splash.window.webContents.emit('did-finish-load');
      splash.window.emit('ready-to-show');
      await splash.ready;
    },
  };
}

test('splash uses isolated local assets and publishes the latest real stage after loading', async (t) => {
  const f = fixture(t);
  const { window } = f.splash;
  assert.equal(window.options.show, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.partition, 'startup');
  assert.match(window.file, /startup[/\\]index\.html$/);
  assert.deepEqual(window.open(), { action: 'deny' });
  let blocked = false;
  window.webContents.emit('will-navigate', { preventDefault() { blocked = true; } });
  assert.equal(blocked, true);
  f.splash.update('connecting');
  assert.equal(f.states.length, 0);
  await f.ready();
  assert.equal(window.shows, 1);
  assert.equal(f.states.at(-1).phase, 'connecting');
  assert.equal(f.states.at(-1).version, '0.11.0');
  f.splash.update('interface');
  assert.equal(f.states.at(-1).step, 2);
  assert.throws(() => f.splash.update('invented-file'), /Unknown startup phase/);
});

test('closing is sender-scoped and preserves backend shutdown ownership', async (t) => {
  const f = fixture(t);
  await f.ready();
  const sender = f.splash.window.webContents;
  f.ipcMain.emit('startup:close', { sender: {}, senderFrame: sender.mainFrame });
  f.ipcMain.emit('startup:close', { sender, senderFrame: {} });
  assert.equal(f.closes(), 0);
  f.ipcMain.emit('startup:close', { sender, senderFrame: sender.mainFrame });
  assert.equal(f.closes(), 1);
  let prevented = false;
  f.splash.window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.closes(), 2);
  f.allowClose();
  f.splash.window.emit('close', { preventDefault() { assert.fail('confirmed shutdown should close'); } });
});

test('handoff shows the main window before disposing the splash and its IPC listener', async (t) => {
  const f = fixture(t);
  await f.ready();
  let shown = false;
  const main = { show() { assert.equal(f.splash.isDestroyed(), false); shown = true; } };
  f.splash.complete(main);
  assert.equal(shown, true);
  assert.equal(f.splash.isDestroyed(), true);
  assert.equal(f.ipcMain.listenerCount('startup:close'), 0);
  assert.equal(f.states.at(-1).phase, 'ready');
  f.splash.complete({ show() { assert.fail('handoff must be idempotent'); } });
});

test('startup failures remain visible instead of silently quitting', async (t) => {
  const f = fixture(t);
  assert.equal(f.splash.fail(new Error('before loading')), false);
  await f.ready();
  assert.equal(f.splash.fail(new Error('Backend build not found')), true);
  assert.equal(f.states.at(-1).failed, true);
  assert.equal(f.states.at(-1).detail, 'Backend build not found');
  f.splash.update('closing');
  assert.equal(f.states.at(-1).title, 'Closing safely');
});

test('splash asset load errors reject startup so the native error fallback can run', async (t) => {
  const error = new Error('missing startup page');
  const f = fixture(t, { loadError: error });
  await assert.rejects(f.splash.ready, error);
  assert.equal(f.splash.fail(error), false);
});

function bootstrapFixture({ dev = false, exists = true, port = Promise.resolve(4319), backendReady = Promise.resolve() } = {}) {
  const calls = [];
  let resolveSplash;
  const splash = {
    ready: new Promise((resolve) => { resolveSplash = resolve; }),
    update: (phase) => calls.push(phase),
  };
  const context = {
    BrowserWindow: {}, ipcMain: {}, appIcon: () => null, readPersistedTheme: () => 'dark',
    app: { getVersion: () => '0.11.0', quit() {} },
    startupCancelled: false, startupSplash: null, desktopInitialized: false,
    initializeDesktop: () => calls.push('initialize'),
    IS_DEV: dev, DEV_URL: 'http://localhost:5173', HOST: '127.0.0.1', BACKEND_ENTRY: 'backend/dist/main.js',
    fs: { existsSync: () => exists }, isBackendShutdownConfirmed: () => true,
    getFreePort: () => port, startBackend: () => calls.push('spawn'),
    waitForBackend: () => backendReady, setAppOrigin: (url) => calls.push(url),
    createWindow: (_url, actualSplash) => { assert.equal(actualSplash, splash); calls.push('window'); },
    updateManager: { init: () => calls.push('updater') },
    require: () => ({ createStartupSplash: () => { calls.push('splash'); return splash; } }),
  };
  const main = fs.readFileSync(path.join(desktop, 'main.cjs'), 'utf8');
  vm.runInNewContext(main.slice(main.indexOf('async function bootstrap()'), main.indexOf('\nfunction reportStartupFailure')) +
    '\nglobalThis.start = bootstrap;', context);
  return { calls, context, start: () => context.start(), ready: () => resolveSplash() };
}

test('production shows the splash before starting services and waits for actual backend readiness', async () => {
  let backendReady;
  const f = bootstrapFixture({ backendReady: new Promise((resolve) => { backendReady = resolve; }) });
  const boot = f.start();
  assert.deepEqual(f.calls, ['splash']);
  f.ready();
  await tick();
  assert.deepEqual(f.calls, ['splash', 'initialize', 'starting', 'spawn', 'connecting']);
  backendReady();
  await boot;
  assert.deepEqual(f.calls.slice(-4), ['interface', 'http://127.0.0.1:4319/', 'window', 'updater']);
});

test('development startup reuses services without creating a second backend', async () => {
  const f = bootstrapFixture({ dev: true });
  const boot = f.start();
  f.ready();
  await boot;
  assert.equal(f.calls.includes('spawn'), false);
  assert.equal(f.calls.includes('development'), true);
  assert.equal(f.calls.includes('http://localhost:5173'), true);
  const next = f.start();
  await next;
  assert.equal(f.calls.filter((call) => call === 'initialize').length, 1);
});

test('closing during startup cannot spawn a late backend or open a hidden main window', async () => {
  let resolvePort;
  const f = bootstrapFixture({ port: new Promise((resolve) => { resolvePort = resolve; }) });
  const boot = f.start();
  f.ready();
  await tick();
  f.context.startupCancelled = true;
  resolvePort(4319);
  await boot;
  assert.equal(f.calls.includes('spawn'), false);
  assert.equal(f.calls.includes('window'), false);
});

test('missing backend files reject startup instead of claiming a ready workspace', async () => {
  const f = bootstrapFixture({ exists: false });
  const boot = f.start();
  f.ready();
  await assert.rejects(boot, /Backend build not found/);
  assert.equal(f.calls.includes('spawn'), false);
  assert.equal(f.calls.includes('window'), false);
});

test('startup assets are packaged, use the 1024px icon, and respect reduced motion', () => {
  const builder = yaml.load(fs.readFileSync(path.join(desktop, 'electron-builder.yml'), 'utf8'));
  assert.ok(builder.files.includes('startup-splash.cjs'));
  assert.ok(builder.files.includes('startup/**/*'));
  const icon = fs.readFileSync(path.join(desktop, 'build-resources', 'icon.png'));
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
  const html = fs.readFileSync(path.join(desktop, 'startup', 'index.html'), 'utf8');
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /src="\.\.\/build-resources\/icon\.png"/);
  assert.match(html, /script-src 'self'/);
  const css = fs.readFileSync(path.join(desktop, 'startup', 'startup.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('renderer shows real milestones and errors as text, with theme and close controls', () => {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(path.join(desktop, 'startup', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  let listener;
  let closed = false;
  let unsubscribed = false;
  dom.window.startup = {
    onState(callback) { listener = callback; return () => { unsubscribed = true; }; },
    close() { closed = true; },
  };
  try {
    dom.window.eval(fs.readFileSync(path.join(desktop, 'startup', 'startup.js'), 'utf8'));
    listener({ step: 2, title: 'Loading the interface', detail: 'Loading scripts and styles.',
      version: '0.11.0', theme: 'light', failed: false });
    const document = dom.window.document;
    assert.equal(document.querySelector('.wordmark'), null);
    assert.equal(document.querySelector('.eyebrow').textContent, 'A space for project development using AI');
    assert.equal(document.querySelector('h1').textContent, 'AI Project Studio.');
    assert.ok(document.querySelector('h1 br'));
    assert.equal(document.querySelector('h1 span').textContent, 'Studio.');
    assert.equal(document.querySelector('.frame-corners').getAttribute('aria-hidden'), 'true');
    assert.equal(document.querySelector('.light-sweep').getAttribute('aria-hidden'), 'true');
    assert.equal(document.querySelector('.tagline').textContent, 'Your ideas. One workspace.');
    assert.equal(document.body.dataset.theme, 'light');
    assert.equal(document.getElementById('version').textContent, 'Version 0.11.0');
    assert.equal(document.querySelector('[data-step="1"]').dataset.state, 'complete');
    assert.equal(document.querySelector('[aria-current="step"]').dataset.step, '2');
    listener({ step: 2, title: 'Startup failed', detail: '<img src=x onerror=alert(1)>',
      version: '0.11.0', theme: 'light', failed: true });
    assert.equal(document.getElementById('status-detail').children.length, 0);
    assert.equal(document.body.dataset.failed, 'true');
    assert.equal(document.getElementById('elapsed').textContent, 'Startup interrupted');
    document.getElementById('close').click();
    assert.equal(closed, true);
    dom.window.dispatchEvent(new dom.window.Event('unload'));
    assert.equal(unsubscribed, true);
  } finally {
    dom.window.close();
  }
});

test('startup preload exposes only progress subscription and close IPC', () => {
  const ipc = new EventEmitter();
  const sent = [];
  ipc.send = (...args) => sent.push(args);
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(desktop, 'startup', 'preload.cjs'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: {
      exposeInMainWorld(name, api) { assert.equal(name, 'startup'); bridge = api; },
    } }),
  });
  assert.deepEqual(Object.keys(bridge), ['onState', 'close']);
  const states = [];
  const unsubscribe = bridge.onState((state) => states.push(state));
  ipc.emit('startup:state', {}, { phase: 'connecting' });
  assert.deepEqual(states, [{ phase: 'connecting' }]);
  bridge.close();
  assert.deepEqual(sent, [['startup:close']]);
  unsubscribe();
  assert.equal(ipc.listenerCount('startup:state'), 0);
});
