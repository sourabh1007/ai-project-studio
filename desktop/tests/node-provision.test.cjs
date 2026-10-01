'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createNodeProvisioner,
  PINNED_VERSION,
  archiveName,
  binarySubPath,
  parseVersion,
  isAcceptableMajor,
  checksumFor,
} = require('../node-provision.cjs');

const ARCHIVE_BYTES = Buffer.from('fake-node-archive-contents');
const ARCHIVE_SHA = crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex');

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tmpRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-provision-'));
  tempDirs.push(dir);
  return dir;
}

/** Builds a provisioner whose IO seams emulate a successful download+extract. */
function harness({ platform = 'win32', arch = 'x64', env = {}, versions = {}, runtimeDir, shasums } = {}) {
  const dir = runtimeDir || tmpRuntime();
  const events = [];
  const extractedFolder = `node-v${PINNED_VERSION}-${platform === 'win32' ? 'win' : platform}-${arch}`;
  const provisioner = createNodeProvisioner({
    platform, arch, env, runtimeDir: dir,
    getText: async () => (shasums !== undefined ? shasums : `${ARCHIVE_SHA}  ${archiveName(PINNED_VERSION, platform, arch)}\n`),
    download: async (_url, dest, onProgress) => {
      onProgress?.(0.5);
      onProgress?.(1);
      fs.writeFileSync(dest, ARCHIVE_BYTES);
    },
    extract: (_archivePath, destDir, plat) => {
      const root = path.join(destDir, extractedFolder);
      const binPath = plat === 'win32' ? path.join(root, 'node.exe') : path.join(root, 'bin', 'node');
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      fs.writeFileSync(binPath, 'binary');
    },
    runVersion: (bin) => {
      let value;
      if (Object.prototype.hasOwnProperty.call(versions, bin)) value = versions[bin];
      else if (bin === 'node') value = versions.node;
      else value = versions.default;
      return value ? parseVersion(value) : null;
    },
    onProgress: (event) => events.push(event),
  });
  return { provisioner, dir, events };
}

test('accepts an explicit CW_NODE_BIN override that runs a usable Node', async () => {
  const { provisioner } = harness({ env: { CW_NODE_BIN: '/opt/custom/node' }, versions: { '/opt/custom/node': 'v24.5.0' } });
  assert.equal(await provisioner.ensureNode(), '/opt/custom/node');
});

test('ignores a CW_NODE_BIN override that is too old and falls back', async () => {
  const { provisioner } = harness({
    env: { CW_NODE_BIN: '/opt/old/node' },
    versions: { '/opt/old/node': 'v20.1.0', node: 'v24.9.0' },
  });
  // Too-old override is rejected; a matching system Node is used instead.
  assert.equal(await provisioner.ensureNode(), 'node');
});

test('reuses an already-provisioned managed runtime without downloading', async () => {
  const dir = tmpRuntime();
  const managedDir = path.join(dir, `node-v${PINNED_VERSION}`);
  const managedBin = path.join(managedDir, 'node.exe');
  fs.mkdirSync(managedDir, { recursive: true });
  fs.writeFileSync(managedBin, 'binary');
  let downloaded = false;
  const provisioner = createNodeProvisioner({
    platform: 'win32', arch: 'x64', env: {}, runtimeDir: dir,
    getText: async () => { throw new Error('should not fetch'); },
    download: async () => { downloaded = true; },
    extract: () => {},
    runVersion: () => parseVersion(`v${PINNED_VERSION}`),
  });
  assert.equal(await provisioner.ensureNode(), managedBin);
  assert.equal(downloaded, false);
});

test('uses a system Node whose major matches the required ABI', async () => {
  const { provisioner } = harness({ versions: { node: 'v24.19.0' } });
  assert.equal(await provisioner.ensureNode(), 'node');
});

test('downloads, checksum-verifies, and extracts the pinned runtime on Windows', async () => {
  const { provisioner, dir, events } = harness({ versions: { default: `v${PINNED_VERSION}`, node: null } });
  const result = await provisioner.ensureNode();
  assert.equal(result, path.join(dir, `node-v${PINNED_VERSION}`, 'node.exe'));
  assert.ok(fs.existsSync(result));
  assert.ok(events.some((e) => e.phase === 'download' && /%$/.test(e.message)));
  assert.ok(events.some((e) => e.phase === 'done'));
});

test('extracts bin/node for non-Windows platforms', async () => {
  const { provisioner, dir } = harness({ platform: 'darwin', arch: 'arm64', versions: { default: `v${PINNED_VERSION}`, node: null } });
  const result = await provisioner.ensureNode();
  assert.equal(result, path.join(dir, `node-v${PINNED_VERSION}`, 'bin', 'node'));
  assert.ok(fs.existsSync(result));
});

test('rejects a runtime whose checksum does not match the published digest', async () => {
  const { provisioner } = harness({ versions: { node: null }, shasums: `deadbeef  ${archiveName(PINNED_VERSION, 'win32', 'x64')}\n` });
  await assert.rejects(provisioner.ensureNode(), /Checksum mismatch/);
});

test('fails when no checksum is published for the archive', async () => {
  const { provisioner } = harness({ versions: { node: null }, shasums: 'unrelated  some-other-file.zip\n' });
  await assert.rejects(provisioner.ensureNode(), /No checksum published/);
});

test('prunes a stale managed runtime before provisioning the pinned version', async () => {
  const dir = tmpRuntime();
  const staleDir = path.join(dir, 'node-v22.1.0');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'node.exe'), 'old');
  const { provisioner } = harness({ runtimeDir: dir, versions: { default: `v${PINNED_VERSION}`, node: null } });
  await provisioner.ensureNode();
  assert.equal(fs.existsSync(staleDir), false);
  assert.ok(fs.existsSync(path.join(dir, `node-v${PINNED_VERSION}`, 'node.exe')));
});

test('derives platform/arch-specific archive names and binary subpaths', () => {
  assert.equal(archiveName('24.20.0', 'win32', 'x64'), 'node-v24.20.0-win-x64.zip');
  assert.equal(archiveName('24.20.0', 'win32', 'arm64'), 'node-v24.20.0-win-arm64.zip');
  assert.equal(archiveName('24.20.0', 'darwin', 'arm64'), 'node-v24.20.0-darwin-arm64.tar.gz');
  assert.equal(archiveName('24.20.0', 'linux', 'x64'), 'node-v24.20.0-linux-x64.tar.gz');
  assert.equal(binarySubPath('24.20.0', 'win32', 'x64'), path.join('node-v24.20.0-win-x64', 'node.exe'));
  assert.equal(binarySubPath('24.20.0', 'darwin', 'arm64'), path.join('node-v24.20.0-darwin-arm64', 'bin', 'node'));
});

test('rejects unsupported platforms and architectures', () => {
  assert.throws(() => archiveName('24.20.0', 'sunos', 'x64'), /Unsupported platform/);
  assert.throws(() => archiveName('24.20.0', 'linux', 'mips'), /Unsupported architecture/);
});

test('version parsing and ABI acceptance helpers', () => {
  assert.deepEqual(parseVersion('v24.20.0'), { major: 24, minor: 20, patch: 0, raw: 'v24.20.0' });
  assert.equal(parseVersion('not-a-version'), null);
  assert.equal(isAcceptableMajor(parseVersion('v24.1.0')), true);
  assert.equal(isAcceptableMajor(parseVersion('v22.5.0')), false);
  assert.equal(isAcceptableMajor(null), false);
});

test('checksum lookup matches the exact archive name only', () => {
  const sums = 'aaaa  node-v24.20.0-win-x64.zip\nbbbb  node-v24.20.0-win-arm64.zip\n';
  assert.equal(checksumFor(sums, 'node-v24.20.0-win-arm64.zip'), 'bbbb');
  assert.equal(checksumFor(sums, 'node-v24.20.0-linux-x64.tar.gz'), null);
});
