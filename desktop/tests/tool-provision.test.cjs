'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createToolProvisioner,
  toolArch,
  GH_SPEC,
  GIT_SPEC,
  GH_VERSION,
  GIT_WINDOWS_VERSION,
} = require('../tool-provision.cjs');

const ARCHIVE_BYTES = Buffer.from('fake-tool-archive');
const ARCHIVE_SHA = crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex');

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
function tmpRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-provision-'));
  tempDirs.push(dir);
  return dir;
}

/** Emulates a download+extract for a spec; `systemOk` toggles a system install. */
function harness(spec, { platform = 'win32', arch = 'x64', env = {}, systemOk = false, runtimeDir, checksumText } = {}) {
  const dir = runtimeDir || tmpRuntime();
  const resolved = spec.resolve({ platform, arch });
  const events = [];
  const provisioner = createToolProvisioner(spec, {
    platform, arch, env, runtimeDir: dir,
    getText: async () => (checksumText !== undefined ? checksumText : `${ARCHIVE_SHA}  ${resolved?.archiveName}\n`),
    download: async (_url, dest, onProgress) => { onProgress?.(0.5); onProgress?.(1); fs.writeFileSync(dest, ARCHIVE_BYTES); },
    extract: (_archivePath, destDir) => {
      const root = resolved.extractedRoot ? path.join(destDir, resolved.extractedRoot) : destDir;
      const binPath = path.join(root, resolved.binSubPath);
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      fs.writeFileSync(binPath, 'binary');
    },
    runProbe: (bin) => {
      if (bin === spec.command) return systemOk;
      if (spec.overrideEnv && bin === env[spec.overrideEnv]) return true;
      return bin.includes(dir); // managed/just-extracted binaries validate
    },
    onProgress: (event) => events.push(event),
  });
  return { provisioner, dir, resolved, events };
}

test('toolArch maps node arch tokens to release arch tokens', () => {
  assert.equal(toolArch('x64'), 'amd64');
  assert.equal(toolArch('arm64'), 'arm64');
});

test('GitHub CLI spec resolves per-platform archive, checksum file, and bin path', () => {
  const win = GH_SPEC.resolve({ platform: 'win32', arch: 'x64' });
  assert.equal(win.archiveName, `gh_${GH_VERSION}_windows_amd64.zip`);
  assert.equal(win.binSubPath, path.join('bin', 'gh.exe'));
  assert.match(win.checksum.url, /checksums\.txt$/);
  const mac = GH_SPEC.resolve({ platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.archiveName, `gh_${GH_VERSION}_macOS_arm64.zip`);
  assert.equal(mac.binSubPath, path.join('bin', 'gh'));
});

test('Git spec provisions MinGit on Windows and defers to system Git elsewhere', () => {
  const win = GIT_SPEC.resolve({ platform: 'win32', arch: 'x64' });
  assert.equal(win.archiveName, `MinGit-${GIT_WINDOWS_VERSION}-64-bit.zip`);
  assert.equal(win.binSubPath, path.join('cmd', 'git.exe'));
  assert.ok(win.checksum.sha256);
  assert.equal(GIT_SPEC.resolve({ platform: 'darwin', arch: 'arm64' }), null);
});

test('prefers a system tool when one is already installed', async () => {
  const { provisioner } = harness(GH_SPEC, { systemOk: true });
  const result = await provisioner.ensure();
  assert.deepEqual(result, { binary: 'gh', binDir: null });
});

test('prefers an explicit per-tool override binary', async () => {
  const { provisioner } = harness(GH_SPEC, { env: { CW_GH_BIN: '/opt/gh/bin/gh' } });
  const result = await provisioner.ensure();
  assert.equal(result.binary, '/opt/gh/bin/gh');
});

test('downloads, checksum-verifies, and extracts the GitHub CLI when absent', async () => {
  const { provisioner, dir, resolved } = harness(GH_SPEC);
  const result = await provisioner.ensure();
  const expected = path.join(dir, `gh-v${GH_VERSION}`, resolved.binSubPath);
  assert.equal(result.binary, expected);
  assert.equal(result.binDir, path.dirname(expected));
  assert.ok(fs.existsSync(expected));
});

test('extracts a flat archive directly into the managed directory', async () => {
  const dir = tmpRuntime();
  const flatSpec = {
    id: 'git', label: 'Git', command: 'git', probeArgs: ['--version'], overrideEnv: 'CW_GIT_BIN',
    resolve: () => ({
      version: GIT_WINDOWS_VERSION,
      url: 'https://example/MinGit.zip',
      archiveName: 'MinGit.zip',
      extractedRoot: '', // flat archive: files land at the staging root
      binSubPath: path.join('cmd', 'git.exe'),
      checksum: { sha256: ARCHIVE_SHA },
    }),
  };
  const { provisioner } = harness(flatSpec, { runtimeDir: dir });
  const result = await provisioner.ensure();
  const expected = path.join(dir, `git-v${GIT_WINDOWS_VERSION}`, 'cmd', 'git.exe');
  assert.equal(result.binary, expected);
  assert.ok(fs.existsSync(expected));
});

test('reuses an already-provisioned managed tool without downloading', async () => {
  const dir = tmpRuntime();
  const resolved = GH_SPEC.resolve({ platform: 'win32', arch: 'x64' });
  const managedBin = path.join(dir, `gh-v${GH_VERSION}`, resolved.binSubPath);
  fs.mkdirSync(path.dirname(managedBin), { recursive: true });
  fs.writeFileSync(managedBin, 'binary');
  let downloaded = false;
  const provisioner = createToolProvisioner(GH_SPEC, {
    platform: 'win32', arch: 'x64', env: {}, runtimeDir: dir,
    getText: async () => { throw new Error('no fetch'); },
    download: async () => { downloaded = true; },
    extract: () => {},
    runProbe: (bin) => bin === managedBin,
  });
  const result = await provisioner.ensure();
  assert.equal(result.binary, managedBin);
  assert.equal(downloaded, false);
});

test('rejects a tool archive whose checksum does not match', async () => {
  const { provisioner, resolved } = harness(GH_SPEC, { checksumText: `deadbeef  ${GH_SPEC.resolve({ platform: 'win32', arch: 'x64' }).archiveName}\n` });
  await assert.rejects(provisioner.ensure(), /Checksum mismatch/);
  void resolved;
});

test('prunes a stale managed version before installing the pinned one', async () => {
  const dir = tmpRuntime();
  const staleDir = path.join(dir, 'gh-v2.0.0');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'old'), 'x');
  const { provisioner } = harness(GH_SPEC, { runtimeDir: dir });
  await provisioner.ensure();
  assert.equal(fs.existsSync(staleDir), false);
});

test('returns null for a tool that cannot be provisioned on this platform', async () => {
  // Git on macOS has no installable spec; with no system git, provisioning is skipped.
  const { provisioner } = harness(GIT_SPEC, { platform: 'darwin', arch: 'arm64', systemOk: false });
  assert.equal(await provisioner.ensure(), null);
});
