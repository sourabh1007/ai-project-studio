'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const control = require('../backend-control.cjs');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.connected = true;
  child.shutdownRequests = [];
  child.send = (message, callback) => {
    child.shutdownRequests.push(message);
    callback(null);
    return true;
  };
  child.kill = () => assert.fail('root kill is not ownership confirmation');
  child.nonce = 'replacement-fixture-nonce';
  child.acknowledge = (nonce = child.nonce) => child.emit('message', { type: 'shutdown-complete', nonce });
  child.finish = (code = 0, signal = null, acknowledge = true) => {
    if (acknowledge) child.acknowledge();
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  return child;
}

function fixture({ stopError = false, httpAvailable = true, waitMs = 15, pageError = false, makeUpdater } = {}) {
  const app = new EventEmitter();
  const notifications = [];
  const messages = [];
  const exitWaitBudgets = [];
  const ipc = {};
  let relaunches = 0;
  let exits = 0;
  let quits = 0;
  let installs = 0;
  let requests = 0;
  let spawned;
  let appQuitting = false;
  const windows = [];
  const pages = [];
  const shell = { openExternal: async (url) => {
    if (pageError) throw new Error('private page error');
    pages.push(url);
  } };
  class FakeWindow extends EventEmitter {
    static getAllWindows() { return windows.filter((win) => !win.destroyed); }
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
      this.focuses = 0;
      windows.push(this);
    }
    isDestroyed() { return !!this.destroyed; }
    isMinimized() { return false; }
    focus() { this.focuses++; }
    loadURL() { return Promise.resolve(); }
    close() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', event);
      if (!event.prevented) this.destroy();
      return event;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
      if (!FakeWindow.getAllWindows().length) app.emit('window-all-closed');
    }
  }
  Object.assign(app, {
    isPackaged: true,
    getPath: () => 'fixture-profile',
    getVersion: () => '0.0.0',
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    relaunch: () => { relaunches++; },
    exit: () => { exits++; },
    quit: () => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      if (appQuitting) return event;
      app.emit('before-quit', event);
      if (!event.prevented) {
        appQuitting = true;
        for (const win of FakeWindow.getAllWindows()) win.close();
        if (!FakeWindow.getAllWindows().length) quits++;
        else appQuitting = false;
      }
      return event;
    },
  });
  const processFake = Object.assign(new EventEmitter(), {
    env: {}, platform: 'win32', resourcesPath: 'fixture-resources',
    stdout: Object.assign(new EventEmitter(), { write() {} }),
    stderr: Object.assign(new EventEmitter(), { write() {} }),
  });
  const au = makeUpdater ? makeUpdater(app) : new EventEmitter();
  if (!makeUpdater) {
    au.quitAndInstall = () => {
      installs++;
      setImmediate(() => app.quit());
    };
  }
  const updaterContext = {
    module: { exports: {} }, process: processFake,
    setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }), clearInterval() {},
    require: (name) => name === 'electron' ? { app, shell }
      : name === 'electron-updater' ? { autoUpdater: au } : require(name),
  };
  vm.runInNewContext(source('update-manager.cjs'), updaterContext);
  const updater = updaterContext.module.exports;
  const electron = {
    app, dialog: { showErrorBox: (title, message) => notifications.push({ title, message }) },
    BrowserWindow: FakeWindow, shell,
    Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    ipcMain: { handle: (name, handler) => { ipc[name] = handler; }, on: () => {} },
  };
  const context = {
    process: processFake, URL, __dirname: path.join(__dirname, '..'),
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === './regression-isolation.cjs') return { configure: () => null };
      if (name === './update-manager.cjs') return updater;
      if (name === './ipc-input.cjs') return {};
      if (name === 'node:fs') return { readFileSync: () => { throw Error('fixture has no theme'); } };
      if (name === 'node:child_process') return { spawn: (_bin, _args, options) => {
        assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe', 'ipc']);
        spawned = childProcess();
        spawned.nonce = options.env.CW_DESKTOP_SHUTDOWN_NONCE;
        assert.equal(typeof spawned.nonce, 'string');
        return spawned;
      } };
      if (name === './backend-control.cjs') return {
        requestBackendShutdown: async () => { requests++; if (stopError) throw Error('private-path-secret'); return httpAvailable; },
        requestBackendShutdownIpc: (child, nonce) =>
          control.requestBackendShutdownIpc(child, nonce, { timeoutMs: waitMs }),
        waitForChildExit: (child, budget) => {
          exitWaitBudgets.push(budget);
          return control.waitForChildExit(child, waitMs);
        },
      };
      return require(name);
    },
  };
  // Evaluate the real entrypoint and its lifecycle registration, without
  // starting Electron, invoking bootstrap, accessing a database, or spawning.
  vm.createContext(context);
  vm.runInContext(source('main.cjs') + `
    globalThis.owner = {
      startBackend, stopBackend, runAfterBackendStop, createWindow,
      get backend() { return backend; },
      replace(child) { ownBackend(child, child.nonce); },
    };
  `, context);
  // Exercise the real production IPC bodies in the same lexical environment.
  const main = source('main.cjs');
  vm.runInContext(`isTrustedSender = (event) => event.trusted;\n` +
    main.slice(main.indexOf("  ipcMain.handle('app:relaunch'"), main.indexOf("  // Opens the documentation")), context);
  updater.init({
    getWindow: () => ({ isDestroyed: () => false, webContents: {
      isDestroyed: () => false, send: (channel, payload) => messages.push({ channel, payload }),
    } }),
    stopBackend: context.owner.stopBackend,
    runAfterBackendStop: context.owner.runAfterBackendStop,
  });
  return {
    app, owner: context.owner, updater, au, ipc, notifications, messages, exitWaitBudgets, windows, pages, shell,
    spawn() { context.owner.startBackend(1234); return spawned; },
    counts: () => ({ relaunches, exits, quits, installs, requests }),
  };
}

test('production relaunch waits for delayed exit, reports confirmation, and rejects untrusted IPC', async () => {
  const f = fixture({ waitMs: 100 });
  const child = f.spawn();
  assert.equal(await f.ipc['app:relaunch']({ trusted: false }), false);
  const result = f.ipc['app:relaunch']({ trusted: true });
  await tick();
  assert.equal(f.counts().relaunches, 0);
  assert.deepEqual(f.exitWaitBudgets, [10000]);
  child.finish();
  assert.equal(await result, true);
  assert.equal(f.counts().relaunches, 1);
  assert.equal(f.counts().exits, 1);
  assert.equal(f.owner.backend, null);
});

test('production stop timeout keeps child owned and permits a deliberate retry, even if killed flag is set', async () => {
  const f = fixture();
  const child = f.spawn();
  child.killed = true;
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
  assert.equal(f.owner.backend, child);
  assert.deepEqual(f.counts(), { relaunches: 0, exits: 0, quits: 0, installs: 0, requests: 1 });
  assert.match(f.notifications[0].message, /try again/);
  assert.throws(() => f.spawn(), /still owned/);
  const retry = f.ipc['app:relaunch']({ trusted: true });
  await tick();
  child.finish();
  assert.equal(await retry, true);
  assert.equal(f.counts().requests, 2);
});

test('production stop rejection is handled without leaking details or exiting and remains retryable', async () => {
  const f = fixture({ stopError: true });
  const child = f.spawn();
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
  assert.equal(f.owner.backend, child);
  assert.equal(f.counts().requests, 2);
  assert.equal(f.counts().relaunches, 0);
  assert.equal(JSON.stringify(f.notifications).includes('private-path-secret'), false);
});

test('every before-quit request is prevented while pending; confirmed exit quits exactly once', async () => {
  const f = fixture({ waitMs: 100 });
  const child = f.spawn();
  assert.equal(f.app.quit().prevented, true);
  assert.equal(f.app.quit().prevented, true);
  assert.equal(f.app.quit().prevented, true);
  await tick();
  assert.equal(f.counts().requests, 1);
  assert.equal(f.counts().quits, 0);
  child.finish();
  await tick();
  assert.equal(f.counts().quits, 1);
});

test('before-quit timeout does not quit and a later quit retries the owned backend', async () => {
  const f = fixture();
  const child = f.spawn();
  assert.equal(f.app.quit().prevented, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.counts().quits, 0);
  assert.equal(f.owner.backend, child);
  assert.equal(f.app.quit().prevented, true);
  await tick();
  child.finish();
  await tick();
  assert.equal(f.counts().quits, 1);
  assert.equal(f.counts().requests, 2);
});

test('previous exit events and stop decisions cannot clear or authorize a replacement generation', async () => {
  const f = fixture({ waitMs: 100 });
  const first = f.spawn();
  const result = f.ipc['app:relaunch']({ trusted: true });
  await tick();
  const second = childProcess();
  f.owner.replace(second);
  first.finish();
  assert.equal(await result, false);
  assert.equal(f.owner.backend, second);
  assert.equal(f.counts().relaunches, 0);
  assert.equal(f.app.quit().prevented, true);
  await tick();
  second.finish();
  await tick();
  assert.equal(f.counts().quits, 1);
});

test('confirmed stop does not grant lasting quit permission to a newly started backend', async () => {
  const f = fixture({ waitMs: 100 });
  const first = f.spawn();
  const stopped = f.owner.stopBackend();
  await tick();
  first.finish();
  assert.equal(await stopped, true);
  const second = f.spawn();
  assert.equal(f.app.quit().prevented, true);
  assert.equal(f.counts().quits, 0);
  await tick();
  second.finish();
  await tick();
  assert.equal(f.counts().quits, 1);
});

test('guided update IPC reports page-open failure, retains the download, and retries without installing or quitting', async () => {
  const f = fixture({ pageError: true });
  const child = f.spawn();
  f.au.emit('update-downloaded', { version: '1.0.0' });
  assert.equal(f.au.autoInstallOnAppQuit, false);
  assert.equal(await f.ipc['update:install']({ trusted: true }), false);
  assert.equal(f.counts().installs, 0);
  assert.equal(f.counts().quits, 0);
  assert.equal(f.owner.backend, child);
  assert.equal(f.messages.some((m) => m.channel === 'update:before-quit'), false);
  assert.match(f.updater.getState().error, /Retry opening/);
  assert.equal(f.updater.getState().status, 'downloaded');
  assert.equal(f.updater.getState().canAutoInstall, false);
  f.shell.openExternal = async (url) => f.pages.push(url);
  assert.equal(await f.ipc['update:install']({ trusted: true }), true);
  assert.equal(f.pages.length, 1);
  assert.equal(f.counts().installs, 0);
  assert.equal(f.counts().quits, 0);
  assert.equal(f.owner.backend, child);
  assert.equal(f.messages.filter((m) => m.channel === 'update:before-quit').length, 0);
  assert.equal(f.updater.hasPendingInstall(), false);
});

test('quit with a downloaded update still awaits cooperative shutdown and never invokes an installer', async () => {
  const f = fixture({ waitMs: 100 });
  const child = f.spawn();
  f.au.emit('update-downloaded', {});
  assert.equal(f.app.quit().prevented, true);
  assert.equal(f.app.quit().prevented, true);
  assert.equal(f.counts().installs, 0);
  await tick();
  child.finish();
  await tick();
  assert.equal(f.counts().installs, 0);
  assert.equal(f.counts().quits, 1);
});

test('quit with a downloaded update and rejected stop leaves the backend owned', async () => {
  const f = fixture({ stopError: true });
  const child = f.spawn();
  f.au.emit('update-downloaded', {});
  assert.equal(f.app.quit().prevented, true);
  await tick();
  assert.equal(f.counts().installs, 0);
  assert.equal(f.counts().quits, 0);
  assert.equal(f.owner.backend, child);
  assert.equal(f.updater.getState().status, 'downloaded');
  assert.match(f.notifications[0].message, /not confirmed/);
});

test('guided install has no updater setImmediate quit window', async () => {
  const f = fixture();
  f.au.emit('update-downloaded', {});
  assert.equal(await f.updater.installNow(), true);
  assert.equal(f.counts().quits, 0);
  assert.equal(f.counts().installs, 0);
  await tick();
  assert.equal(f.counts().quits, 0);
});

test('guided install never invokes even a synchronous failing updater installer', async () => {
  const f = fixture();
  f.au.emit('update-downloaded', {});
  f.au.quitAndInstall = () => assert.fail('unsafe updater API must not be called');
  assert.equal(await f.updater.installNow(), true);
  assert.equal(f.updater.hasPendingInstall(), false);
  assert.equal(f.counts().quits, 0);
  assert.equal(JSON.stringify(f.messages).includes('private installer path'), false);
  assert.equal(await f.updater.installNow(), true);
  assert.equal(f.counts().quits, 0);
});

test('opening a release page behind pending relaunch cannot run an installer', async () => {
  const f = fixture({ waitMs: 100 });
  const child = f.spawn();
  f.au.emit('update-downloaded', {});
  const relaunch = f.ipc['app:relaunch']({ trusted: true });
  assert.equal(await f.updater.installNow(), true);
  await tick();
  child.finish();
  assert.equal(await relaunch, true);
  assert.equal(f.counts().installs, 0);
});

test('real preload relaunch and install return the production main acknowledgements', async () => {
  const f = fixture({ stopError: true, pageError: true });
  f.spawn();
  f.au.emit('update-downloaded', {});
  let bridge;
  vm.runInNewContext(source('preload.cjs'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_, value) => { bridge = value; } },
      ipcRenderer: {
        invoke: (name) => f.ipc[name]({ trusted: true }),
        send() { assert.fail('shutdown requests require acknowledgement'); },
      },
    }),
  });
  assert.equal(await bridge.relaunch(), false);
  assert.equal(await bridge.updates.install(), false);
});

for (const [code, signal, acknowledge] of [[1, null, true], [null, 'SIGKILL', true], [0, null, false]]) {
  test(`exit ${code}/${signal} ack=${acknowledge} cannot authorize relaunch or a later quit/retry`, async () => {
    const f = fixture({ waitMs: 100 });
    const child = f.spawn();
    const pending = f.ipc['app:relaunch']({ trusted: true });
    await tick();
    child.finish(code, signal, acknowledge);
    assert.equal(await pending, false);
    assert.equal(f.owner.backend, null);
    assert.equal(await f.owner.stopBackend(), false);
    assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
    assert.throws(() => f.spawn(), /still owned/);
    assert.equal(f.app.quit().prevented, true);
    await tick();
    assert.equal(f.counts().relaunches, 0);
    assert.equal(f.counts().exits, 0);
    assert.equal(f.counts().quits, 0);
    assert.match(f.notifications[0].message, /without confirmed cooperative cleanup/);
  });
}

test('wrong-generation acknowledgement and an acknowledgement without exit never prove shutdown', async () => {
  const f = fixture();
  const child = f.spawn();
  child.acknowledge('other-generation');
  child.finish(0, null, false);
  assert.equal(await f.owner.stopBackend(), false);
  const g = fixture();
  const live = g.spawn();
  live.acknowledge();
  assert.equal(await g.owner.stopBackend(), false);
  assert.equal(g.owner.backend, live);
});

test('closed HTTP transport can retry through owned IPC only on a deliberate request', async () => {
  const f = fixture({ httpAvailable: false });
  const child = f.spawn();
  child.send = (message, callback) => {
    child.shutdownRequests.push(message);
    callback(null);
    if (child.shutdownRequests.length === 2) queueMicrotask(() => child.finish());
    return false;
  };
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
  assert.equal(f.owner.backend, child);
  assert.equal(child.shutdownRequests.length, 1);
  assert.deepEqual(child.shutdownRequests[0], { type: 'shutdown-request', nonce: child.nonce });
  await tick();
  assert.equal(child.shutdownRequests.length, 1);
  assert.equal(f.counts().relaunches, 0);
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), true);
  assert.equal(child.shutdownRequests.length, 2);
  assert.equal(child.shutdownRequests[1].nonce, child.nonce);
  assert.equal(f.counts().requests, 2);
  assert.equal(f.counts().relaunches, 1);
});

test('IPC callback error is surfaced without releasing ownership and can be retried', async () => {
  const f = fixture({ httpAvailable: false });
  const child = f.spawn();
  child.send = (_message, callback) => { callback(new Error('private IPC path')); return true; };
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
  assert.equal(f.owner.backend, child);
  assert.equal(f.counts().relaunches, 0);
  assert.match(f.notifications[0].message, /not confirmed/);
  assert.equal(JSON.stringify(f.notifications).includes('private IPC path'), false);
  child.send = (message, callback) => {
    child.shutdownRequests.push(message);
    callback(null);
    queueMicrotask(() => child.finish());
    return false;
  };
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), true);
  assert.equal(child.shutdownRequests[0].nonce, child.nonce);
});

test('a queued IPC send without callback times out, remains owned, and does not automatically resend', async () => {
  const f = fixture({ httpAvailable: false });
  const child = f.spawn();
  let sends = 0;
  let complete;
  child.send = (_message, callback) => { sends++; complete = callback; return true; };
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
  complete(null);
  await tick();
  assert.equal(sends, 1);
  assert.equal(f.owner.backend, child);
  assert.equal(f.counts().relaunches, 0);
  assert.equal(f.counts().exits, 0);
  assert.match(f.notifications[0].message, /not confirmed/);
});

test('last-window close remains visible through timeout and second-instance, then closes after a confirmed retry', async () => {
  const f = fixture();
  const child = f.spawn();
  const win = f.owner.createWindow('http://127.0.0.1:1234/');
  assert.equal(win.close().prevented, true);
  assert.equal(win.close().prevented, true);
  f.app.emit('second-instance');
  assert.equal(win.focuses, 1);
  assert.equal(win.isDestroyed(), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(win.isDestroyed(), false);
  assert.equal(f.counts().quits, 0);
  f.app.emit('second-instance');
  assert.equal(win.focuses, 2);
  assert.equal(f.counts().requests, 1);
  assert.equal(win.close().prevented, true);
  await tick();
  child.finish();
  await tick();
  assert.equal(win.isDestroyed(), true);
  assert.equal(f.counts().quits, 1);
});

test('second-instance recovers an unexpectedly destroyed window without spawning another backend', async () => {
  const f = fixture();
  const child = f.spawn();
  const win = f.owner.createWindow('http://127.0.0.1:1234/');
  win.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  f.app.emit('second-instance');
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows[1].isDestroyed(), false);
  assert.equal(f.windows[1].focuses, 1);
  assert.equal(f.owner.backend, child);
  assert.equal(f.counts().quits, 0);
});

test('a rejected stop keeps the titlebar-close window visible and retryable', async () => {
  const f = fixture({ stopError: true });
  f.spawn();
  const win = f.owner.createWindow('http://127.0.0.1:1234/');
  assert.equal(win.close().prevented, true);
  await tick();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.close().prevented, true);
  await tick();
  assert.equal(f.counts().requests, 2);
  assert.equal(f.counts().quits, 0);
  assert.equal(win.isDestroyed(), false);
});

test('app.quit with a visible window never destroys it after abnormal backend exit', async () => {
  const f = fixture({ waitMs: 100 });
  const child = f.spawn();
  const win = f.owner.createWindow('http://127.0.0.1:1234/');
  assert.equal(f.app.quit().prevented, true);
  await tick();
  child.finish(1);
  await tick();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.close().prevented, true);
  await tick();
  assert.equal(f.counts().quits, 0);
});

function installedNsisUpdater(app) {
  const root = path.dirname(require.resolve('electron-updater'));
  const base = fs.readFileSync(path.join(root, 'BaseUpdater.js'), 'utf8');
  const nsis = fs.readFileSync(path.join(root, 'NsisUpdater.js'), 'utf8');
  // Execute installed production methods, not a simplified quit/install fake.
  // Only their IO ports and unused surrounding class construction are replaced.
  const methods = base.slice(base.indexOf('    quitAndInstall('), base.indexOf('    executeDownload(')) +
    base.slice(base.indexOf('    install('), base.indexOf('    addQuitHandler(')) +
    nsis.slice(nsis.indexOf('    doInstall('), nsis.indexOf('    async differentialDownloadWebPackage('));
  const context = {
    EventEmitter, setImmediate, path, process: { resourcesPath: 'fixture-resources' },
    require: () => ({ autoUpdater: new EventEmitter(), shell: {
      openPath: () => assert.fail('no native installer access'),
    } }),
  };
  vm.runInNewContext(`globalThis.Updater = class extends EventEmitter { ${methods} };`, context);
  const au = new context.Updater();
  au.app = app;
  au._logger = { info() {}, warn() {} };
  au.installerPath = 'fixture-installer.exe';
  au.downloadedUpdateHelper = { downloadedFileInfo: {}, file: au.installerPath };
  au.autoRunAppAfterInstall = true;
  au.spawnCalls = 0;
  au.spawnLog = async () => {
    au.spawnCalls++;
    throw Object.assign(new Error('fixture EPERM'), { code: 'EPERM' });
  };
  au.dispatchError = (error) => au.emit('error', error);
  return au;
}

test('installed NSIS methods reproduce async launch failure followed by an unconditional scheduled quit', async () => {
  let quits = 0;
  const au = installedNsisUpdater({ quit: () => { quits++; } });
  const failures = [];
  au.on('error', (error) => failures.push(error.code));
  assert.equal(au.quitAndInstall(false, true), undefined);
  assert.equal(quits, 0);
  await tick();
  assert.deepEqual(failures, ['EPERM']);
  assert.equal(quits, 1);
});

test('guided production manager cannot trigger the installed NSIS async failure/quit race', async () => {
  const f = fixture({ makeUpdater: installedNsisUpdater, waitMs: 100 });
  const child = f.spawn();
  f.au.emit('update-downloaded', {});
  const cache = f.au.downloadedUpdateHelper;
  assert.equal(await f.ipc['update:install']({ trusted: true }), true);
  await tick();
  assert.equal(f.updater.getState().canAutoInstall, false);
  assert.equal(f.pages.length, 1);
  assert.equal(f.au.spawnCalls, 0);
  assert.equal(f.au.downloadedUpdateHelper, cache);
  assert.equal(f.counts().quits, 0);
  assert.equal(f.owner.backend, child);
  assert.equal(f.app.quit().prevented, true);
  await tick();
  child.finish(1);
  await tick();
  assert.equal(f.counts().quits, 0);
  assert.equal(f.au.spawnCalls, 0);
});
