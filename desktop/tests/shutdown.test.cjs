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
// Shutdown now always waits for exit proof, even when a transport hint fails,
// so an unconfirmed attempt settles only after the child-exit budget elapses.
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.pid = 4242;
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

function fixture({ stopError = false, httpAvailable = true, waitMs = 15, pageError = false, makeUpdater, loadPromise, closeResponse = 0, env = {} } = {}) {
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
  const timers = [];
  const pages = [];
  const closePrompts = [];
  const startupRequests = [];
  const startupLogs = [];
  const shell = { openExternal: async (url) => {
    if (pageError) throw new Error('private page error');
    pages.push(url);
  } };
  class FakeWindow extends EventEmitter {
    static getAllWindows() { return windows.filter((win) => !win.destroyed); }
    constructor(options) {
      super();
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
      this.focuses = 0;
      this.options = options;
      this.shows = 0;
      windows.push(this);
    }
    isDestroyed() { return !!this.destroyed; }
    isMinimized() { return false; }
    focus() { this.focuses++; }
    loadURL() { return loadPromise || Promise.resolve(); }
    show() { this.shows++; }
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
    env, platform: 'win32', resourcesPath: 'fixture-resources',
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
    app, dialog: {
      showErrorBox: (title, message) => notifications.push({ title, message }),
      showMessageBox: async (options) => {
        closePrompts.push(options);
        return { response: await closeResponse };
      },
    },
    BrowserWindow: FakeWindow, shell,
    Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    ipcMain: { handle: (name, handler) => { ipc[name] = handler; }, on: () => {} },
  };
  const context = {
    process: processFake, URL, AbortController, __dirname: path.join(__dirname, '..'),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === './regression-isolation.cjs') return { configure: () => null };
      if (name === './update-manager.cjs') return updater;
      if (name === './ipc-input.cjs') return {};
      if (name === './backend-identity.cjs') return require('../backend-identity.cjs');
      if (name === 'node:fs') return {
        readFileSync: () => { throw Error('fixture has no theme'); },
        mkdirSync() {},
        writeFileSync: (file, text) => startupLogs.push({ file, text }),
      };
      if (name === 'node:http') return {
        get(url, respond) {
          const req = Object.assign(new EventEmitter(), {
            url, respond, destroyed: false,
            setTimeout(_ms, callback) { this.timeout = callback; },
            destroy() { this.destroyed = true; },
          });
          startupRequests.push(req);
          return req;
        },
      };
      if (name === 'node:child_process') return { spawn: (_bin, _args, options) => {
        assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe', 'ipc']);
        spawned = childProcess();
        spawned.nonce = options.env.CW_DESKTOP_SHUTDOWN_NONCE;
        spawned.launchId = options.env.CW_DESKTOP_LAUNCH_ID;
        assert.equal(typeof spawned.nonce, 'string');
        assert.equal(typeof spawned.launchId, 'string');
        // The published identity must never carry the shutdown secret.
        assert.notEqual(spawned.launchId, spawned.nonce);
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
      // Relative specifiers in main.cjs are relative to desktop/, not to this
      // test file, so resolve them there before falling back to the real load.
      return require(
        name.startsWith('./') ? path.join(__dirname, '..', name) : name,
      );
    },
  };
  // Evaluate the real entrypoint and its lifecycle registration, without
  // starting Electron, invoking bootstrap, accessing a database, or spawning.
  vm.createContext(context);
  vm.runInContext(source('main.cjs') + `
    globalThis.owner = {
      startBackend, stopBackend, runAfterBackendStop, createWindow, waitForBackend,
      reportStartupFailure, isBackendShutdownConfirmed,
      get backend() { return backend; },
      setSplash(splash) { startupSplash = splash; },
      supervise(port) { supervisedPort = port; },
      get restarts() { return backendRestarts; },
      replace(child) { ownBackend(child, child.nonce, child.launchId); },
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
    app, owner: context.owner, updater, au, ipc, notifications, messages, exitWaitBudgets, windows, pages, shell, timers,
    closePrompts, startupRequests, startupLogs,
    spawn() { context.owner.startBackend(1234); return spawned; },
    /**
     * Answers a pending readiness probe the way the real backend's /identity
     * route does, so startup exercises the full parse-and-verify path.
     */
    respondIdentity(index, overrides = {}, statusCode = 200) {
      const body = overrides === null ? null : {
        launchId: spawned.launchId,
        pid: spawned.pid,
        version: '0.11.3',
        protocolVersion: 1,
        ...overrides,
      };
      const res = Object.assign(new EventEmitter(), {
        statusCode, resume() {}, setEncoding() {},
      });
      startupRequests[index].respond(res);
      if (body !== null) res.emit('data', JSON.stringify(body));
      res.emit('end');
      return res;
    },
    counts: () => ({ relaunches, exits, quits, installs, requests }),
  };
}

test('a failed spawn reports a missing Node runtime immediately and can quit without cleanup acknowledgement', async () => {
  const f = fixture();
  const child = f.spawn();
  const ready = f.owner.waitForBackend(1234);
  const rejected = assert.rejects(ready, /Node.js was not found.*Node.js 24 LTS/);
  delete child.pid;
  child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
  await rejected;
  assert.equal(f.startupRequests[0].destroyed, true);
  assert.equal(f.owner.backend, null);
  assert.equal(f.owner.isBackendShutdownConfirmed(), true);
  assert.equal(f.app.quit().prevented, false);
  assert.equal(f.counts().quits, 1);
  assert.equal(f.closePrompts.length, 0);
});

test('early backend exit reports captured stderr instead of waiting for the readiness timeout', async () => {
  const f = fixture();
  const child = f.spawn();
  const ready = f.owner.waitForBackend(1234);
  const rejected = assert.rejects(ready, /exit code 1[\s\S]*Cannot find module/);
  child.stderr.emit('data', Buffer.from('Error: Cannot find module required-package'));
  child.finish(1, null, false);
  await rejected;
  assert.equal(f.startupRequests[0].destroyed, true);
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(child.listenerCount('error'), 1);
  assert.equal(f.timers[0].cleared, true);
});

test('an already exited backend is detected before making any readiness request', async () => {
  const f = fixture();
  f.spawn().finish(1, null, false);
  await assert.rejects(f.owner.waitForBackend(1234), /exit code 1/);
  assert.equal(f.startupRequests.length, 0);
});

test('readiness uses the configured API path, rejects HTTP errors, and clears all timers on success', async () => {
  const f = fixture({ env: { CW__api__basePath: 'custom/api/' } });
  const child = f.spawn();
  const ready = f.owner.waitForBackend(1234);
  assert.equal(f.startupRequests[0].url, 'http://127.0.0.1:1234/custom/api/identity');
  f.respondIdentity(0, {}, 404);
  f.timers[1].callback();
  f.respondIdentity(1);
  await ready;
  assert.equal(f.timers[0].cleared, true);
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(child.listenerCount('error'), 1);
});

test('a stranger holding the port never satisfies readiness and is named in the timeout', async () => {
  const f = fixture();
  f.spawn();
  const ready = f.owner.waitForBackend(1234);
  const rejected = assert.rejects(ready, /did not start in time. Another program is already using this port/);
  // Unparseable output from a proxy is untrusted and keeps the probe retrying.
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, resume() {}, setEncoding() {},
  });
  f.startupRequests[0].respond(res);
  res.emit('data', '<html>proxy error</html>');
  res.emit('end');
  f.timers.at(-1).callback();
  // A squatting server answers 200 with a body that is not our launch.
  assert.equal(f.startupRequests.length, 2);
  f.respondIdentity(1, { launchId: 'someone-else' });
  f.timers[0].callback();
  await rejected;
});

test('a half-upgraded backend fails fast instead of retrying until the readiness timeout', async () => {
  const f = fixture();
  f.spawn();
  const ready = f.owner.waitForBackend(1234);
  const rejected = assert.rejects(ready, /protocol 1 but the backend \(version 0\.10\.3\) speaks 2[\s\S]*reinstall/i);
  f.respondIdentity(0, { protocolVersion: 2, version: '0.10.3' });
  await rejected;
  // Fatal: no retry was scheduled and the probe was torn down.
  assert.equal(f.startupRequests.length, 1);
  assert.equal(f.startupRequests[0].destroyed, true);
  assert.equal(f.timers[0].cleared, true);
});

test('a foreign process answering for our launch id is refused', async () => {
  const f = fixture();
  const child = f.spawn();
  const ready = f.owner.waitForBackend(1234);
  const rejected = assert.rejects(ready, new RegExp(`different backend process \\(pid ${child.pid + 1}\\)`));
  f.respondIdentity(0, { pid: child.pid + 1 });
  f.timers[0].callback();
  await rejected;
});

test('readiness cancellation stops requests and retries without releasing a running child', async () => {
  const f = fixture({ stopError: true });
  const child = f.spawn();
  const ready = f.owner.waitForBackend(1234);
  const rejected = assert.rejects(ready, /Startup cancelled/);
  f.startupRequests[0].emit('error', new Error('ECONNREFUSED'));
  f.app.quit();
  await rejected;
  assert.equal(f.owner.backend, child);
  assert.equal(f.startupRequests[0].destroyed, true);
  assert.ok(f.timers.every((timer) => timer.cleared));
  await tick();
});

test('readiness has a bounded overall timeout even if a request never responds', async () => {
  const f = fixture();
  f.spawn();
  const ready = f.owner.waitForBackend(1234);
  const rejected = assert.rejects(ready, /Backend did not start in time/);
  f.timers[0].callback();
  await rejected;
  assert.equal(f.startupRequests[0].destroyed, true);
});

test('startup diagnostics persist bounded error output and link the file from the splash', () => {
  const f = fixture();
  const child = f.spawn();
  child.stderr.emit('data', Buffer.from('x'.repeat(20000) + '\nActual startup error'));
  let shown;
  f.owner.setSplash({ fail(error) { shown = error.message; return true; } });
  f.owner.reportStartupFailure(new Error('Backend failed'));
  assert.equal(f.startupLogs.length, 1);
  assert.match(f.startupLogs[0].file, /desktop-startup\.log$/);
  assert.match(f.startupLogs[0].text, /Actual startup error/);
  assert.ok(f.startupLogs[0].text.length < 21000);
  assert.match(shown, /Diagnostics:.*desktop-startup\.log/);
});

test('a dead unacknowledged backend can close the desktop with explicit consent but cannot authorize replacement', async () => {
  const f = fixture({ closeResponse: 1 });
  f.spawn().finish(1, null, false);
  const win = f.owner.createWindow('http://fixture');
  assert.equal(f.app.quit().prevented, true);
  await tick();
  assert.equal(f.closePrompts.length, 1);
  assert.match(f.closePrompts[0].detail, /cleanup could not be confirmed/);
  assert.equal(f.counts().quits, 1);
  assert.equal(win.isDestroyed(), true);
  assert.equal(f.owner.isBackendShutdownConfirmed(), false);
  assert.equal(await f.ipc['app:relaunch']({ trusted: true }), false);
  assert.throws(() => f.spawn(), /still owned/);
  assert.equal(f.counts().relaunches, 0);
});

test('declining dead-backend close keeps the window open and stops misleading closing animation', async () => {
  const f = fixture();
  const failures = [];
  let animated;
  f.owner.setSplash({
    update() { animated = true; }, isDestroyed: () => false,
    fail(error) { animated = false; failures.push(error.message); },
  });
  f.spawn().finish(1, null, false);
  f.app.quit();
  f.app.quit();
  await tick();
  assert.equal(f.closePrompts.length, 1);
  assert.equal(f.counts().quits, 0);
  assert.match(failures.at(-1), /backend has already stopped/);
  assert.equal(f.notifications.length, 0);
  assert.equal(animated, false);
});

test('close consent for a dead backend never authorizes a different generation', async () => {
  let respond;
  const f = fixture({ closeResponse: new Promise((resolve) => { respond = resolve; }) });
  f.spawn().finish(1, null, false);
  f.app.quit();
  const replacement = childProcess();
  f.owner.replace(replacement);
  respond(1);
  await tick();
  assert.equal(f.counts().quits, 0);
  assert.equal(f.owner.backend, replacement);
});

test('a backend crash during cooperative quit offers the same exit-only recovery', async () => {
  const f = fixture({ waitMs: 100, closeResponse: 1 });
  const child = f.spawn();
  f.app.quit();
  await tick();
  child.finish(1, null, false);
  await tick();
  assert.equal(f.closePrompts.length, 1);
  assert.equal(f.counts().quits, 1);
  assert.equal(f.owner.isBackendShutdownConfirmed(), false);
});

test('startup handoff waits for successful loading and a painted main window', async () => {
  let resolveLoad;
  const f = fixture({ loadPromise: new Promise((resolve) => { resolveLoad = resolve; }) });
  let handoffs = 0;
  const splash = { complete(win) { handoffs++; win.show(); }, fail() { assert.fail('unexpected startup failure'); } };
  const win = f.owner.createWindow('http://fixture', splash);
  assert.equal(win.options.show, false);
  win.emit('ready-to-show');
  assert.equal(handoffs, 0);
  resolveLoad();
  await tick();
  assert.equal(handoffs, 1);
  assert.equal(win.shows, 1);
  assert.equal(f.timers[0].cleared, true);
});

test('an interface load failure cannot reveal a blank window and timeout stays visible', async () => {
  const f = fixture({ loadPromise: Promise.reject(new Error('network unavailable')) });
  const failures = [];
  const splash = { complete() { assert.fail('failed page must stay hidden'); }, fail(error) { failures.push(error.message); } };
  const win = f.owner.createWindow('http://fixture', splash);
  win.emit('ready-to-show');
  await tick();
  assert.equal(win.shows, 0);
  f.timers[0].callback();
  assert.match(failures[0], /taking too long/);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.match(failures[1], /crashed/);
});

test('a splash is not another app window that can bypass backend shutdown', async () => {
  const f = fixture({ waitMs: 100 });
  const child = f.spawn();
  const splashWindow = f.owner.createWindow('file://startup');
  const splash = { window: splashWindow, update() {}, isDestroyed: () => false };
  f.owner.setSplash(splash);
  const win = f.owner.createWindow('http://fixture');
  assert.equal(win.close().prevented, true);
  await tick();
  assert.equal(f.counts().quits, 0);
  child.finish();
  await tick();
  assert.equal(f.owner.backend, null);
});

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
  await settle();
  assert.equal(f.counts().installs, 0);
  assert.equal(f.counts().quits, 0);
  assert.equal(f.owner.backend, child);
  assert.equal(f.updater.getState().status, 'downloaded');
  // An unresponsive backend never exits, so it can never report an outcome.
  // The user is offered a force close rather than a dead-end error box, and
  // declining it still leaves the backend owned with no install performed.
  assert.equal(f.closePrompts.length, 1);
  assert.match(f.closePrompts[0].detail, /not responding/);
  // main.cjs runs in a separate vm realm, so compare by value not prototype.
  assert.deepEqual(Array.from(f.closePrompts[0].buttons), ['Keep open', 'Force close']);
  assert.equal(f.notifications.length, 0);
});

test('a hung backend can still be force closed instead of trapping the user', async () => {
  // Previously only a *crashed* backend could be escaped: the exit-based
  // consent path required an outcome, which a hung process never produces, so
  // the app refused to quit forever.
  const f = fixture({ stopError: true, closeResponse: 1 });
  const child = f.spawn();
  // A real SIGKILL is reaped by the OS; the fake child must do the same or the
  // test would be asserting against a process that ignores kill.
  child.kill = () => child.finish(null, 'SIGKILL', false);
  assert.equal(f.app.quit().prevented, true);
  await settle();
  assert.equal(f.closePrompts.length, 1);
  assert.equal(f.counts().quits, 1);
  // Forcing a close must never claim cleanup or start a replacement.
  assert.equal(f.counts().installs, 0);
  assert.equal(f.counts().relaunches, 0);
  assert.equal(f.owner.backend, null);
});

test('a crashed backend is restarted automatically once it has proven ready', async () => {
  const f = fixture();
  const child = f.spawn();
  f.owner.supervise(1234);
  child.finish(1, null, false);
  // Restarting is deferred, so a backend that dies on launch cannot spin.
  assert.equal(f.owner.backend, null);
  const scheduled = f.timers.at(-1);
  assert.equal(scheduled.delay, 500);
  scheduled.callback();
  const replacement = f.owner.backend;
  assert.notEqual(replacement, null);
  assert.notEqual(replacement, child);
  // The replacement reuses the proven port so the loaded window keeps working.
  assert.equal(f.owner.isBackendShutdownConfirmed(), false);
});

test('repeated crashes back off and then report the backend as unavailable', async () => {
  const f = fixture();
  f.spawn();
  f.owner.supervise(1234);
  const delays = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    f.owner.backend.finish(1, null, false);
    const scheduled = f.timers.at(-1);
    delays.push(scheduled.delay);
    scheduled.callback();
  }
  assert.deepEqual(delays, [500, 1000, 2000, 5000, 10000]);
  const before = f.timers.length;
  f.owner.backend.finish(1, null, false);
  // The run is bounded: no further restart is scheduled.
  assert.equal(f.timers.length, before);
  // Ownership of a reaped process is released so the user can recover, but
  // nothing claims the backend shut down cleanly.
  assert.equal(f.owner.backend, null);
  assert.equal(f.owner.isBackendShutdownConfirmed(), true);
});

test('an intentional stop is never undone by a restart', async () => {
  const f = fixture();
  const child = f.spawn();
  f.owner.supervise(1234);
  const stopped = f.owner.stopBackend();
  child.finish();
  assert.equal(await stopped, true);
  assert.equal(f.owner.backend, null);
  assert.equal(f.owner.restarts, 0);
});

test('an unsupervised backend that never became ready is not blindly respawned', async () => {
  const f = fixture();
  const child = f.spawn();
  child.finish(1, null, false);
  assert.equal(f.owner.backend, null);
  assert.equal(f.owner.restarts, 0);
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
  // A second close while the first attempt is still proving exit coalesces onto
  // it rather than issuing a duplicate shutdown request.
  assert.equal(win.close().prevented, true);
  await settle();
  assert.equal(f.counts().requests, 1);
  // Once the unconfirmed attempt settles, closing is retryable and does ask again.
  assert.equal(win.close().prevented, true);
  await settle();
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
