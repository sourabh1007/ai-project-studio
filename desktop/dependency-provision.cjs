'use strict';

// Orchestrates first-run provisioning of the external tools the app depends on,
// reporting clearly-labelled progress to the splash screen. Node.js is required
// (the backend can't run without it) so a Node failure is fatal; Git and the
// GitHub CLI are best-effort — if they can't be provisioned the app still runs,
// with the features that need them degraded until the tool is available.
//
// Every provisioned tool contributes a bin directory. The caller prepends these
// to the backend's PATH, which is what makes `node`, `npm` (shipped with Node,
// used by the Agency/Copilot CLI installers), `git`, and `gh` resolvable to the
// managed copies — including on a machine that had none of them to begin with.

const nodePath = require('node:path');
const { createNodeProvisioner } = require('./node-provision.cjs');
const { createToolProvisioner, GIT_SPEC, GH_SPEC } = require('./tool-provision.cjs');

/**
 * Provisions all backend dependencies.
 *
 * @returns {Promise<{ nodeBin: string, binDirs: string[] }>}
 */
async function provisionDependencies(deps) {
  const {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    runtimeDir,
    signal,
    log = () => {},
    onProgress = () => {},
    pathImpl = nodePath,
    makeNodeProvisioner = createNodeProvisioner,
    makeToolProvisioner = createToolProvisioner,
  } = deps;

  const binDirs = [];

  // 1) Node.js — required. Its directory also provides npm.
  onProgress({ tool: 'node', label: 'Node.js runtime', message: 'Checking the Node.js runtime…' });
  const nodeProvisioner = makeNodeProvisioner({
    platform, arch, env, runtimeDir, signal, log,
    onProgress: (event) => onProgress({ tool: 'node', label: 'Node.js runtime', ...event }),
  });
  const nodeBin = await nodeProvisioner.ensureNode();
  if (pathImpl.isAbsolute(nodeBin)) {
    binDirs.push(pathImpl.dirname(nodeBin));
  }

  // 2) Git and GitHub CLI — best effort; never block startup.
  for (const spec of [GIT_SPEC, GH_SPEC]) {
    onProgress({ tool: spec.id, label: spec.label, message: `Checking ${spec.label}…` });
    try {
      const provisioner = makeToolProvisioner(spec, {
        platform, arch, env, runtimeDir, signal, log,
        onProgress: (event) => onProgress({ tool: spec.id, ...event }),
      });
      const result = await provisioner.ensure();
      if (result && result.binDir) {
        binDirs.push(result.binDir);
      }
    } catch (error) {
      log(`${spec.label} provisioning failed (continuing): ${error.message}`);
    }
  }

  return { nodeBin, binDirs };
}

/** Prepends `binDirs` to a PATH string using the platform delimiter, de-duped. */
function prependToPath(binDirs, currentPath, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const existing = (currentPath ?? '').split(delimiter).filter(Boolean);
  const seen = new Set(existing.map((dir) => dir.toLowerCase()));
  const additions = [];
  for (const dir of binDirs) {
    if (dir && !seen.has(dir.toLowerCase())) {
      additions.push(dir);
      seen.add(dir.toLowerCase());
    }
  }
  return [...additions, ...existing].join(delimiter);
}

module.exports = { provisionDependencies, prependToPath };
