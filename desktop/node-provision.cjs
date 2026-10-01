'use strict';

// Self-provisioning Node.js runtime for the backend.
//
// The backend is spawned as a *system* Node process (not Electron's bundled
// Node) because it relies on the experimental `node:sqlite` builtin, and it
// loads `node-pty` — an ABI-specific native addon compiled in CI against a
// fixed Node major. A machine without a compatible Node therefore can't start
// the app at all. Rather than ask the user to install Node by hand, this module
// provisions a pinned Node runtime into the app's data directory on first run
// (downloaded from the official nodejs.org dist, checksum-verified against the
// release's SHASUMS256.txt), and reuses it on later launches.
//
// PINNED_VERSION must track the Node version CI builds `node-pty` against
// (.github/workflows — setup-node). The runtime's major establishes the native
// ABI, so only a matching major is acceptable; bumping CI's Node means bumping
// this constant so the provisioned runtime keeps matching the shipped addon.

const { spawnSync } = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { httpGetText, downloadToFile, extractArchive, sha256File, checksumFor } = require('./provision-io.cjs');

const PINNED_VERSION = '24.20.0';
const REQUIRED_MAJOR = 24;
const DIST_BASE = 'https://nodejs.org/dist';

/** Maps Node's process.platform to the nodejs.org dist platform token. */
function distPlatform(platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform for Node provisioning: ${platform}`);
}

/** Maps Node's process.arch to the nodejs.org dist arch token. */
function distArch(arch) {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`Unsupported architecture for Node provisioning: ${arch}`);
}

/** Archive basename (no directory) for a platform/arch/version on nodejs.org. */
function archiveName(version, platform, arch) {
  const base = `node-v${version}-${distPlatform(platform)}-${distArch(arch)}`;
  return platform === 'win32' ? `${base}.zip` : `${base}.tar.gz`;
}

/** The node binary's path inside the extracted archive directory. */
function binarySubPath(version, platform, arch) {
  const dir = `node-v${version}-${distPlatform(platform)}-${distArch(arch)}`;
  return platform === 'win32'
    ? nodePath.join(dir, 'node.exe')
    : nodePath.join(dir, 'bin', 'node');
}

/** Parses a semver-ish "vX.Y.Z" string into numeric parts, or null. */
function parseVersion(text) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: match[0] };
}

/** True when a runtime version satisfies the ABI (major) the app was built for. */
function isAcceptableMajor(version) {
  return version != null && version.major === REQUIRED_MAJOR;
}

/** Returns the installed version of a node binary via `node --version`, or null. */
function readNodeVersion(binPath, runImpl = spawnSync) {
  try {
    const result = runImpl(binPath, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) return null;
    return parseVersion(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Ensures a Node runtime matching the pinned major is available, returning its
 * absolute path. Resolution order:
 *   1. An explicit `CW_NODE_BIN` override (trusted if it runs and is >= 22.5).
 *   2. The managed pinned runtime already installed under `runtimeDir`.
 *   3. A system `node` on PATH whose major matches (avoids a needless download).
 *   4. Download + verify + extract the pinned runtime into `runtimeDir`.
 * Any managed runtime of a *different* version is pruned first (silent upgrade).
 *
 * IO is injected so the logic is unit-testable without real network/disk.
 */
function createNodeProvisioner(deps) {
  const {
    platform,
    arch,
    env = {},
    runtimeDir,
    signal,
    fsImpl = nodeFs,
    pathImpl = nodePath,
    download = (url, dest, onProg) => downloadToFile(url, dest, onProg, signal),
    getText = (url) => httpGetText(url, signal),
    extract = extractArchive,
    runVersion = (bin) => readNodeVersion(bin),
    hashFile = (file) => sha256File(file, fsImpl),
    log = () => {},
    onProgress = () => {},
  } = deps;

  const managedDir = pathImpl.join(runtimeDir, `node-v${PINNED_VERSION}`);
  // The archive's versioned folder is renamed onto `managedDir`, so the binary
  // lives directly under it (not under the archive's own folder name).
  const managedBinary = pathImpl.join(managedDir, platform === 'win32' ? 'node.exe' : pathImpl.join('bin', 'node'));

  function overrideBinary() {
    const override = env.CW_NODE_BIN;
    if (!override) return null;
    const version = runVersion(override);
    // An explicit override is a power-user/dev escape hatch: accept any Node new
    // enough for node:sqlite, trusting the operator to match the native ABI.
    if (version && (version.major > 22 || (version.major === 22 && version.minor >= 5))) {
      log(`using CW_NODE_BIN override at ${override} (v${version.raw.replace(/^v/, '')})`);
      return override;
    }
    log(`ignoring CW_NODE_BIN override at ${override}: not a usable Node >= 22.5`);
    return null;
  }

  function managedBinaryIfValid() {
    if (!fsImpl.existsSync(managedBinary)) return null;
    const version = runVersion(managedBinary);
    if (isAcceptableMajor(version) && version.raw.replace(/^v/, '') === PINNED_VERSION) {
      return managedBinary;
    }
    return null;
  }

  function pruneStaleRuntimes() {
    let entries;
    try {
      entries = fsImpl.readdirSync(runtimeDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('node-v') && entry !== `node-v${PINNED_VERSION}`) {
        try {
          fsImpl.rmSync(pathImpl.join(runtimeDir, entry), { recursive: true, force: true });
          log(`removed stale managed Node runtime ${entry}`);
        } catch (error) {
          log(`could not remove stale runtime ${entry}: ${error.message}`);
        }
      }
    }
  }

  function systemBinary() {
    const version = runVersion('node');
    if (isAcceptableMajor(version)) {
      log(`using system Node on PATH (v${version.raw.replace(/^v/, '')})`);
      return 'node';
    }
    return null;
  }

  async function installPinned() {
    const name = archiveName(PINNED_VERSION, platform, arch);
    const versionBase = `${DIST_BASE}/v${PINNED_VERSION}`;
    onProgress({ phase: 'download', fraction: 0, message: 'Preparing Node.js runtime…' });
    fsImpl.mkdirSync(runtimeDir, { recursive: true });
    const archivePath = pathImpl.join(runtimeDir, name);

    const shasums = await getText(`${versionBase}/SHASUMS256.txt`);
    const expected = checksumFor(shasums, name);
    if (!expected) {
      throw new Error(`No checksum published for ${name}`);
    }

    await download(`${versionBase}/${name}`, archivePath, (fraction) => {
      onProgress({ phase: 'download', fraction, message: `Downloading Node.js runtime… ${Math.round(fraction * 100)}%` });
    });

    onProgress({ phase: 'verify', fraction: 1, message: 'Verifying Node.js runtime…' });
    const actual = hashFile(archivePath);
    if (actual.toLowerCase() !== expected) {
      try { fsImpl.rmSync(archivePath, { force: true }); } catch { /* best effort */ }
      throw new Error(`Checksum mismatch for ${name}`);
    }

    onProgress({ phase: 'extract', fraction: 1, message: 'Installing Node.js runtime…' });
    // Extract into runtimeDir; the archive contains the versioned folder, so the
    // result is runtimeDir/node-v<version>-<plat>-<arch>/... which `managedDir`
    // (node-v<version>) does not match — install under the exact managed dir.
    const stagingDir = pathImpl.join(runtimeDir, `.staging-${PINNED_VERSION}`);
    fsImpl.rmSync(stagingDir, { recursive: true, force: true });
    fsImpl.mkdirSync(stagingDir, { recursive: true });
    extract(archivePath, stagingDir, platform);
    const extractedRoot = pathImpl.join(stagingDir, `node-v${PINNED_VERSION}-${distPlatform(platform)}-${distArch(arch)}`);
    fsImpl.rmSync(managedDir, { recursive: true, force: true });
    fsImpl.renameSync(extractedRoot, managedDir);
    fsImpl.rmSync(stagingDir, { recursive: true, force: true });
    try { fsImpl.rmSync(archivePath, { force: true }); } catch { /* best effort */ }

    const version = runVersion(managedBinary);
    if (!isAcceptableMajor(version)) {
      throw new Error('Provisioned Node runtime failed to run');
    }
    log(`provisioned Node v${PINNED_VERSION} at ${managedBinary}`);
    onProgress({ phase: 'done', fraction: 1, message: 'Node.js runtime ready.' });
    return managedBinary;
  }

  async function ensureNode() {
    const override = overrideBinary();
    if (override) return override;

    const existing = managedBinaryIfValid();
    if (existing) {
      log(`reusing managed Node v${PINNED_VERSION}`);
      return existing;
    }

    pruneStaleRuntimes();

    const system = systemBinary();
    if (system) return system;

    return installPinned();
  }

  return { ensureNode, managedBinary, pinnedVersion: PINNED_VERSION };
}

module.exports = {
  createNodeProvisioner,
  // Exported for unit tests and reuse:
  PINNED_VERSION,
  REQUIRED_MAJOR,
  distPlatform,
  distArch,
  archiveName,
  binarySubPath,
  parseVersion,
  isAcceptableMajor,
  checksumFor,
  readNodeVersion,
};
