'use strict';

// Generic provisioner for a self-contained external CLI distributed as a
// downloadable archive (GitHub CLI, portable Git, …). It mirrors the Node
// provisioner's shape but is tool-agnostic: a `spec` describes where to fetch
// the archive, how to verify it, and where its binary lives once extracted.
//
// Resolution order for each tool:
//   1. A per-tool env override (e.g. CW_GH_BIN) that runs successfully.
//   2. The managed copy already installed under runtimeDir (skip download).
//   3. A system copy on PATH that runs successfully (avoid a needless download).
//   4. Download + checksum-verify + extract the pinned archive into runtimeDir.
// Stale managed versions are pruned first so a pinned-version bump upgrades
// silently. A tool whose spec can't be resolved for this platform returns null
// (the caller treats it as "best effort, not available") rather than throwing.

const { spawnSync } = require('node:child_process');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const io = require('./provision-io.cjs');

/** Runs `<bin> <probeArgs>` and returns true when it exits cleanly. */
function runsOk(binPath, probeArgs, runImpl = spawnSync) {
  try {
    const result = runImpl(binPath, probeArgs, { encoding: 'utf8', timeout: 15000 });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Creates a provisioner for one tool.
 *
 * `spec` is `{ id, label, command, probeArgs, overrideEnv, resolve }` where
 * `resolve({ platform, arch })` returns either null (unsupported on this
 * platform — fall back to system only) or:
 *   {
 *     version,                 // pinned version string, names the managed dir
 *     url,                     // archive download URL
 *     archiveName,             // archive basename (for checksum lookup + temp file)
 *     binSubPath,              // binary path relative to the install root
 *     extractedRoot,           // folder the archive expands into, or '' if flat
 *     checksum: { sha256 } | { url, name },  // fixed digest, or a checksums file
 *   }
 */
function createToolProvisioner(spec, deps = {}) {
  const {
    platform,
    arch,
    env = {},
    runtimeDir,
    signal,
    fsImpl = nodeFs,
    pathImpl = nodePath,
    download = (url, dest, onProg) => io.downloadToFile(url, dest, onProg, signal),
    getText = (url) => io.httpGetText(url, signal),
    extract = io.extractArchive,
    hashFile = (file) => io.sha256File(file, fsImpl),
    runProbe = (bin) => runsOk(bin, spec.probeArgs),
    log = () => {},
    onProgress = () => {},
  } = deps;

  const resolved = spec.resolve({ platform, arch });
  const toolDir = resolved ? pathImpl.join(runtimeDir, `${spec.id}-v${resolved.version}`) : null;
  const managedBinary = resolved ? pathImpl.join(toolDir, resolved.binSubPath) : null;

  function overrideBinary() {
    const override = spec.overrideEnv ? env[spec.overrideEnv] : undefined;
    if (override && runProbe(override)) {
      log(`using ${spec.overrideEnv} override at ${override}`);
      return { binary: override, binDir: pathImpl.dirname(override) };
    }
    return null;
  }

  function managedIfValid() {
    if (managedBinary && fsImpl.existsSync(managedBinary) && runProbe(managedBinary)) {
      return { binary: managedBinary, binDir: pathImpl.dirname(managedBinary) };
    }
    return null;
  }

  function pruneStale() {
    let entries;
    try {
      entries = fsImpl.readdirSync(runtimeDir);
    } catch {
      return;
    }
    const keep = resolved ? `${spec.id}-v${resolved.version}` : null;
    for (const entry of entries) {
      if (entry.startsWith(`${spec.id}-v`) && entry !== keep) {
        try {
          fsImpl.rmSync(pathImpl.join(runtimeDir, entry), { recursive: true, force: true });
          log(`removed stale ${spec.id} ${entry}`);
        } catch (error) {
          log(`could not remove stale ${spec.id} ${entry}: ${error.message}`);
        }
      }
    }
  }

  function systemBinary() {
    if (runProbe(spec.command)) {
      log(`using system ${spec.command} on PATH`);
      return { binary: spec.command, binDir: null };
    }
    return null;
  }

  async function install() {
    onProgress({ phase: 'download', fraction: 0, message: `Preparing ${spec.label}…` });
    fsImpl.mkdirSync(runtimeDir, { recursive: true });
    const archivePath = pathImpl.join(runtimeDir, resolved.archiveName);

    let expected;
    if (resolved.checksum.sha256) {
      expected = resolved.checksum.sha256.toLowerCase();
    } else {
      const sums = await getText(resolved.checksum.url);
      expected = io.checksumFor(sums, resolved.checksum.name);
      if (!expected) throw new Error(`No checksum published for ${resolved.archiveName}`);
    }

    await download(resolved.url, archivePath, (fraction) => {
      onProgress({ phase: 'download', fraction, message: `Downloading ${spec.label}… ${Math.round(fraction * 100)}%` });
    });

    onProgress({ phase: 'verify', fraction: 1, message: `Verifying ${spec.label}…` });
    const actual = hashFile(archivePath);
    if (actual.toLowerCase() !== expected) {
      try { fsImpl.rmSync(archivePath, { force: true }); } catch { /* best effort */ }
      throw new Error(`Checksum mismatch for ${resolved.archiveName}`);
    }

    onProgress({ phase: 'extract', fraction: 1, message: `Installing ${spec.label}…` });
    const stagingDir = pathImpl.join(runtimeDir, `.staging-${spec.id}-${resolved.version}`);
    fsImpl.rmSync(stagingDir, { recursive: true, force: true });
    fsImpl.mkdirSync(stagingDir, { recursive: true });
    extract(archivePath, stagingDir, platform);
    // Some archives expand into a single versioned folder; others are flat.
    const installSource = resolved.extractedRoot
      ? pathImpl.join(stagingDir, resolved.extractedRoot)
      : stagingDir;
    fsImpl.rmSync(toolDir, { recursive: true, force: true });
    fsImpl.renameSync(installSource, toolDir);
    fsImpl.rmSync(stagingDir, { recursive: true, force: true });
    try { fsImpl.rmSync(archivePath, { force: true }); } catch { /* best effort */ }

    if (!runProbe(managedBinary)) {
      throw new Error(`Provisioned ${spec.label} failed to run`);
    }
    log(`provisioned ${spec.label} v${resolved.version} at ${managedBinary}`);
    onProgress({ phase: 'done', fraction: 1, message: `${spec.label} ready.` });
    return { binary: managedBinary, binDir: pathImpl.dirname(managedBinary) };
  }

  async function ensure() {
    const override = overrideBinary();
    if (override) return override;

    const existing = managedIfValid();
    if (existing) {
      log(`reusing managed ${spec.label} v${resolved.version}`);
      return existing;
    }

    pruneStale();

    const system = systemBinary();
    if (system) return system;

    // Nothing on the system and no installable spec for this platform.
    if (!resolved) {
      log(`${spec.label} is unavailable and cannot be provisioned on ${platform}`);
      return null;
    }
    return install();
  }

  return { ensure, managedBinary, resolved };
}

/** nodejs.org-style arch token for the GitHub CLI / Git archives. */
function toolArch(arch) {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  return arch;
}

const GH_VERSION = '2.102.0';
const GIT_WINDOWS_VERSION = '2.56.0';
// Published on the git-for-windows release as the MinGit-2.56.0-64-bit.zip asset
// digest. MinGit has no checksums file, so the digest is pinned with the version.
const GIT_WINDOWS_MINGIT_SHA256 = '064b440ff870ed5198527e8f3a92cdf5bd2fd0fedf5e718af95e3fdaddeff718';

/** Spec for the GitHub CLI (`gh`) — a self-contained archive on every platform. */
const GH_SPEC = {
  id: 'gh',
  label: 'GitHub CLI',
  command: 'gh',
  probeArgs: ['--version'],
  overrideEnv: 'CW_GH_BIN',
  resolve({ platform, arch }) {
    const osToken = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macOS' : 'linux';
    const archToken = toolArch(arch);
    const ext = platform === 'linux' ? 'tar.gz' : 'zip';
    const folder = `gh_${GH_VERSION}_${osToken}_${archToken}`;
    const archiveName = `${folder}.${ext}`;
    const base = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;
    const binSubPath = platform === 'win32'
      ? nodePath.join('bin', 'gh.exe')
      : nodePath.join('bin', 'gh');
    return {
      version: GH_VERSION,
      url: `${base}/${archiveName}`,
      archiveName,
      extractedRoot: folder,
      binSubPath,
      checksum: { url: `${base}/gh_${GH_VERSION}_checksums.txt`, name: archiveName },
    };
  },
};

/** Spec for Git. Portable MinGit is provisioned on Windows; macOS/Linux rely on
 * the system git (present by default via Xcode CLT / distro packages). */
const GIT_SPEC = {
  id: 'git',
  label: 'Git',
  command: 'git',
  probeArgs: ['--version'],
  overrideEnv: 'CW_GIT_BIN',
  resolve({ platform }) {
    if (platform !== 'win32') return null;
    const archiveName = `MinGit-${GIT_WINDOWS_VERSION}-64-bit.zip`;
    return {
      version: GIT_WINDOWS_VERSION,
      url: `https://github.com/git-for-windows/git/releases/download/v${GIT_WINDOWS_VERSION}.windows.1/${archiveName}`,
      archiveName,
      extractedRoot: '', // MinGit expands flat (cmd/, mingw64/, …)
      binSubPath: nodePath.join('cmd', 'git.exe'),
      checksum: { sha256: GIT_WINDOWS_MINGIT_SHA256 },
    };
  },
};

module.exports = {
  createToolProvisioner,
  toolArch,
  runsOk,
  GH_SPEC,
  GIT_SPEC,
  GH_VERSION,
  GIT_WINDOWS_VERSION,
};
