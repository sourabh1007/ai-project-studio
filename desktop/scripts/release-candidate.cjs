'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashFile } = require('./smoke-helpers.cjs');

async function writeCandidateManifest({ root, platform, sourceSha, runId, runAttempt }) {
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error('Candidate provenance requires a shipped platform');
  }
  if (!/^[a-f0-9]{40}$/i.test(sourceSha ?? '') ||
      !/^[1-9][0-9]*$/.test(runId ?? '') ||
      !/^[1-9][0-9]*$/.test(runAttempt ?? '')) {
    throw new Error('Candidate provenance requires an exact CI commit, run, and attempt');
  }

  const lockFile = path.join(root, 'package-lock.json');
  const stagedLockFile = path.join(root, 'desktop', 'build', 'backend', 'package-lock.json');
  const lockSha256 = await hashFile(lockFile);
  if (lockSha256 !== await hashFile(stagedLockFile)) {
    throw new Error('Staged dependency lock differs from the verified source lock');
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
  const releaseDir = path.join(root, 'desktop', 'release');
  const names = fs.readdirSync(releaseDir)
    .filter((name) => /\.(exe|dmg|blockmap|yml)$/.test(name))
    .sort();
  const installerExtension = platform === 'win32' ? '.exe' : '.dmg';
  if (!names.some((name) => name.endsWith(installerExtension))) {
    throw new Error('Candidate has no installer for its declared platform');
  }
  const artifacts = [];
  for (const name of names) {
    const file = path.join(releaseDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Candidate artifact must be a nonempty regular file: ${name}`);
    }
    artifacts.push({ name, bytes: stat.size, sha256: await hashFile(file) });
  }
  const manifest = {
    schemaVersion: 1,
    channel: 'internal',
    qualification: 'pending',
    signatureVerification: 'pending',
    sourceSha,
    ci: { runId, runAttempt },
    platform,
    version: metadata.version,
    lockSha256,
    buildRuntime: { node: process.version, nodeModuleAbi: process.versions.modules },
    packagedRuntimeVerification: 'pending',
    artifacts,
  };
  const output = path.join(releaseDir, `candidate-${platform}.json`);
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
  return { output, manifest };
}

module.exports = { writeCandidateManifest };

if (require.main === module) {
  writeCandidateManifest({
    root: path.resolve(__dirname, '..', '..'),
    platform: process.platform,
    sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  }).then(({ output }) => {
    console.log(`Internal candidate recorded at ${output}; release qualification remains pending.`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
