'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { attachRendererRecovery, RECOVERY_DELAY_MS, RESET_AFTER_MS } = require('../renderer-recovery.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, options = {}) {
  const win = new EventEmitter();
  const url = options.url || 'http://127.0.0.1:4319/';
  const loads = [];
  const records = [];
  const timers = [];
  let destroyed = false;
  let quitting = false;
  let ready = true;
  let failures = 0;
  let prompts = 0;
  let crashes = 0;
  let currentUrl = url;
  win.isDestroyed = () => destroyed;
  win.loadURL = (target) => {
    loads.push(target);
    currentUrl = target;
    return options.load ? options.load(target) : Promise.resolve();
  };
  win.webContents = Object.assign(new EventEmitter(), {
    getURL: () => currentUrl,
    forcefullyCrashRenderer() { crashes++; gone(); },
  });
  const gone = (reason = 'crashed') =>
    win.webContents.emit('render-process-gone', {}, { reason, exitCode: -1073741819 });
  const dispose = attachRendererRecovery({
    window: win, url, record: (entry) => records.push(entry),
    showFailure: () => { failures++; },
    confirmReload: async () => { prompts++; return options.confirm?.(); },
    canRecover: () => ready, isQuitting: () => quitting,
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false, fired: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel(timer) { timer.cancelled = true; },
  });
  t.after(dispose);
  return {
    win, url, loads, records, timers, gone, dispose,
    failCount: () => failures, prompts: () => prompts, crashes: () => crashes,
    ready(value) { ready = value; }, quitting(value) { quitting = value; },
    destroy() { destroyed = true; win.emit('closed'); },
    loaded() { win.webContents.emit('did-finish-load'); },
    run(delay) {
      const pending = timers.filter((timer) => timer.delay === delay && !timer.cancelled && !timer.fired);
      for (const timer of pending) { timer.fired = true; timer.callback(); }
    },
    recover() { gone(); this.run(RECOVERY_DELAY_MS); this.loaded(); },
  };
}

test('a post-start crash reloads the same window and preserves detached-tab URLs', (t) => {
  const f = fixture(t, { url: 'http://127.0.0.1:4319/?popout=tab#encoded-tab' });
  f.gone('oom');
  f.gone('oom');
  assert.equal(f.loads.length, 0);
  f.run(RECOVERY_DELAY_MS);
  assert.deepEqual(f.loads, [f.url]);
  assert.deepEqual(f.records, [{ kind: 'renderer-exit', reason: 'oom', exitCode: -1073741819, action: 'reload' }]);
});

test('repeated crashes stop automatic reloads and leave a safe, actionable recovery page', (t) => {
  const f = fixture(t, { url: 'http://127.0.0.1:4319/?a=1&b="><script>alert(1)</script>' });
  f.recover();
  f.recover();
  f.recover();
  assert.equal(f.loads.length, 3);
  assert.equal(f.loads[0], f.url);
  assert.equal(f.loads[1], f.url);
  const html = decodeURIComponent(f.loads[2].split(',').slice(1).join(','));
  assert.match(html, /Reload interface/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:4319\/\?a=1&amp;b=&quot;&gt;&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /default-src 'none'/);
  f.run(RESET_AFTER_MS);
  f.recover();
  f.recover();
  assert.equal(f.loads.length, 3);
  assert.equal(f.failCount(), 1);
});

test('a minute of healthy app rendering resets the crash budget', (t) => {
  const f = fixture(t);
  f.recover();
  f.recover();
  f.run(RESET_AFTER_MS);
  f.recover();
  assert.deepEqual(f.loads, [f.url, f.url, f.url]);
});

test('startup failures remain owned by the splash and clean exits do not reload', (t) => {
  const f = fixture(t);
  f.ready(false);
  f.gone();
  f.run(RECOVERY_DELAY_MS);
  assert.equal(f.records[0].action, 'startup-failure');
  assert.equal(f.loads.length, 0);
  f.ready(true);
  f.gone('clean-exit');
  assert.equal(f.records.length, 1);
});

test('shutdown and window destruction cancel pending recovery and remove listeners', (t) => {
  for (const shutdown of [true, false]) {
    const f = fixture(t);
    f.loaded();
    f.gone();
    if (shutdown) f.quitting(true);
    else f.destroy();
    f.run(RECOVERY_DELAY_MS);
    assert.equal(f.loads.length, 0);
    f.gone();
    assert.equal(f.records.length, 1);
    if (!shutdown) {
      assert.equal(f.win.webContents.listenerCount('render-process-gone'), 0);
      assert.equal(f.win.webContents.listenerCount('did-finish-load'), 0);
      assert.equal(f.win.listenerCount('unresponsive'), 0);
      assert.ok(f.timers.every((timer) => timer.cancelled || timer.fired));
    }
  }
});

test('failed recovery navigation records diagnostics and presents the native fallback', async (t) => {
  for (const load of [
    () => Promise.reject(new Error('navigation failed')),
    () => { throw new Error('navigation failed'); },
  ]) {
    const f = fixture(t, { load });
    f.recover();
    await tick();
    assert.equal(f.records[1].kind, 'renderer-recovery-failed');
    assert.equal(f.failCount(), 1);
  }
});

test('closing a destroyed BrowserWindow never reads its native webContents getter', (t) => {
  const f = fixture(t);
  const contents = f.win.webContents;
  Object.defineProperty(f.win, 'webContents', {
    get() { throw new TypeError('Object has been destroyed'); },
  });
  f.loaded = () => contents.emit('did-finish-load');
  f.loaded();
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.doesNotThrow(() => f.destroy());
  assert.doesNotThrow(() => f.dispose());
  assert.equal(contents.listenerCount('render-process-gone'), 0);
  assert.equal(contents.listenerCount('did-finish-load'), 0);
  assert.equal(f.win.listenerCount('closed'), 0);
  assert.ok(f.timers.every((timer) => timer.cancelled));
  f.run(RECOVERY_DELAY_MS);
  assert.deepEqual(f.loads, []);
});

test('unresponsive windows offer one native prompt and crash-reload only with consent', async (t) => {
  let respond;
  const f = fixture(t, { confirm: () => new Promise((resolve) => { respond = resolve; }) });
  f.win.emit('unresponsive');
  f.win.emit('unresponsive');
  assert.equal(f.prompts(), 1);
  respond(false);
  await tick();
  assert.equal(f.crashes(), 0);
  f.win.emit('unresponsive');
  respond(true);
  await tick();
  assert.equal(f.crashes(), 1);
  f.run(RECOVERY_DELAY_MS);
  assert.deepEqual(f.loads, [f.url]);
});

test('a late prompt response cannot crash a closing window', async (t) => {
  let respond;
  const f = fixture(t, { confirm: () => new Promise((resolve) => { respond = resolve; }) });
  f.win.emit('unresponsive');
  f.destroy();
  respond(true);
  await tick();
  assert.equal(f.crashes(), 0);
});

test('a late prompt response cannot crash an interface that already recovered', async (t) => {
  for (const recover of [(f) => f.recover(), (f) => f.win.emit('responsive')]) {
    let respond;
    const f = fixture(t, { confirm: () => new Promise((resolve) => { respond = resolve; }) });
    f.win.emit('unresponsive');
    recover(f);
    respond(true);
    await tick();
    assert.equal(f.crashes(), 0);
  }
});

test('renderer recovery is included in packaged desktop builds', () => {
  const builder = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8'));
  assert.ok(builder.files.includes('renderer-recovery.cjs'));
});
