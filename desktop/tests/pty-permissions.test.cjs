'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixPtyPermissions } = require('../../backend/scripts/fix-pty-permissions.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pty-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('repairs macOS prebuilt and source-built helpers while preserving existing permission bits', (t) => {
  const root = fixture(t);
  const helpers = ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64'].map((dir) => {
    const helper = path.join(root, dir, 'spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, 'fixture', { mode: 0o644 });
    return helper;
  });
  const expected = helpers.map((helper) => [helper, (fs.statSync(helper).mode & 0o777) | 0o111]);
  const originalChmod = fs.chmodSync;
  const calls = [];
  t.mock.method(fs, 'chmodSync', (helper, mode) => {
    calls.push([helper, mode]);
    originalChmod(helper, mode);
  });
  fixPtyPermissions({ platform: 'darwin', arch: 'arm64', packageDir: root });
  assert.deepEqual(calls, expected);
  if (process.platform !== 'win32') {
    for (const helper of helpers) assert.equal(fs.statSync(helper).mode & 0o111, 0o111);
  }
});

test('non-macOS installations do not resolve or change native helpers', () => {
  for (const platform of ['win32', 'linux']) {
    fixPtyPermissions({ platform, packageDir: 'missing-package' });
  }
});

test('missing or invalid macOS helpers fail installation explicitly', (t) => {
  const root = fixture(t);
  assert.throws(() => fixPtyPermissions({ platform: 'darwin', packageDir: root }), /No macOS/);
  fs.mkdirSync(path.join(root, 'build', 'Release', 'spawn-helper'), { recursive: true });
  assert.throws(() => fixPtyPermissions({ platform: 'darwin', packageDir: root }), /not a regular file/);
});

test('permission failures propagate instead of reporting a repaired installation', (t) => {
  const root = fixture(t);
  const helper = path.join(root, 'prebuilds', 'darwin-x64', 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, 'fixture');
  const error = new Error('permission denied');
  t.mock.method(fs, 'chmodSync', () => { throw error; });
  assert.throws(() => fixPtyPermissions({ platform: 'darwin', arch: 'x64', packageDir: root }), error);
});

test('backend production installs run the permission repair', () => {
  const manifest = require('../../backend/package.json');
  assert.equal(manifest.scripts.postinstall, 'node scripts/fix-pty-permissions.cjs');
});
