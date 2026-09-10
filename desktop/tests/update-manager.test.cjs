'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'update-manager.cjs'),
  'utf8',
);

/**
 * Loads update-manager in isolation. Only the pure release-selection helpers
 * are exercised here; the electron surface is stubbed so nothing is started.
 */
function loadUpdater() {
  const app = Object.assign(new EventEmitter(), {
    getVersion: () => '0.11.5',
    isPackaged: false,
  });
  const context = {
    module: { exports: {} },
    process: Object.assign(new EventEmitter(), { env: {}, platform: 'win32' }),
    setTimeout: () => ({ unref() {} }),
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    require: (name) =>
      name === 'electron'
        ? { app, shell: { openExternal() {} } }
        : name === 'electron-updater'
          ? { autoUpdater: new EventEmitter() }
          : require(name),
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

const release = (tag, extra = {}) => ({ tag_name: tag, ...extra });

test('newestRelease picks the highest published version', () => {
  const { newestRelease } = loadUpdater();
  const best = newestRelease([
    release('v0.11.2'),
    release('v0.11.10'),
    release('v0.11.9'),
  ]);
  assert.equal(best.version, '0.11.10');
});

test('newestRelease honours prereleases, which /releases/latest skips', () => {
  // Every release ships as `--prerelease --latest=false`, so ignoring them
  // would report "up to date" forever — the original bug.
  const { newestRelease } = loadUpdater();
  const best = newestRelease([release('v0.12.0', { prerelease: true })]);
  assert.equal(best.version, '0.12.0');
});

test('newestRelease skips drafts, which are not downloadable', () => {
  const { newestRelease } = loadUpdater();
  const best = newestRelease([
    release('v0.11.6'),
    release('v0.99.0', { draft: true }),
  ]);
  assert.equal(best.version, '0.11.6');
});

test('newestRelease ignores entries with no usable tag', () => {
  const { newestRelease } = loadUpdater();
  assert.equal(newestRelease([null, {}, release('')]), null);
});

test('newestRelease tolerates a non-list body instead of throwing', () => {
  const { newestRelease } = loadUpdater();
  assert.equal(newestRelease(null), null);
  assert.equal(newestRelease({ message: 'rate limited' }), null);
});

test('isNewer orders patch, prerelease and equal versions', () => {
  const { isNewer } = loadUpdater();
  assert.equal(isNewer('0.11.6', '0.11.5'), true);
  assert.equal(isNewer('0.11.5', '0.11.6'), false);
  assert.equal(isNewer('0.11.5', '0.11.5'), false);
  // A stable release supersedes a prerelease of the same core version.
  assert.equal(isNewer('0.11.5', '0.11.5-rc.1'), true);
  assert.equal(isNewer('0.11.5-rc.1', '0.11.5'), false);
});
