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
function loadUpdater(overrides = {}) {
  const app = Object.assign(new EventEmitter(), {
    getVersion: () => '0.11.5',
    isPackaged: !!overrides.packaged,
    getPath: () => path.join(__dirname, 'fixture-profile'),
    quit: () => assert.fail('an injected timer must not quit the test host'),
  });
  const context = {
    module: { exports: {} },
    process: Object.assign(new EventEmitter(), { env: {}, platform: 'win32', arch: 'x64' }),
    Buffer, URL,
    setTimeout: () => ({ unref() {} }),
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    require: (name) =>
      name === 'electron'
        ? { app, shell: { openExternal() {} } }
        : name === 'electron-updater'
          ? { autoUpdater: new EventEmitter() }
          : overrides.modules?.[name] || require(name),
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

const version = '0.12.0';
const installerName = `AI-Project-Studio-${version}-win-x64.exe`;
const asset = (name) => ({
  name, browser_download_url: `https://github.com/sourabh1007/ai-project-studio/releases/download/v${version}/${name}`,
});
const pins = ['a'.repeat(40)];
const policy = { requireAuthenticode: true, signerThumbprints: pins };
const candidate = () => ({
  schemaVersion: 1, qualification: 'passed', signatureVerification: 'passed',
  version, platform: 'win32', arch: 'x64',
  artifacts: [{ name: installerName, bytes: 42, sha256: 'b'.repeat(64) }],
});

test('installer selection matches exact version, architecture, basename and trusted release URL', () => {
  const { pickWindowsInstaller } = loadUpdater();
  const assets = [asset('unrelated.exe'), asset(installerName), asset('candidate-win32-x64.json')];
  assert.equal(pickWindowsInstaller(assets, version, 'x64').name, installerName);
  assert.equal(pickWindowsInstaller(assets, version, 'arm64'), null);
  assert.equal(pickWindowsInstaller(assets, '0.13.0', 'x64'), null);
  assert.equal(pickWindowsInstaller([...assets, asset(installerName)], version, 'x64'), null);
  assert.equal(pickWindowsInstaller([{ ...asset(installerName), browser_download_url: 'https://untrusted.invalid/a.exe' }], version, 'x64'), null);
});

test('candidate trust rejects pending provenance, mismatched identities/checksums and absent signer policy', () => {
  const { validateCandidate, pickWindowsInstaller } = loadUpdater();
  const selected = pickWindowsInstaller([asset(installerName)], version, 'x64');
  assert.equal(validateCandidate(candidate(), selected, policy).signed, true);
  for (const patch of [
    { qualification: 'pending' }, { version: '0.13.0' }, { platform: 'darwin' }, { arch: 'arm64' },
    { signatureVerification: 'pending' }, { artifacts: [{ name: installerName, bytes: 42, sha256: 'bad' }] },
    { artifacts: [{ name: 'other.exe', bytes: 42, sha256: 'b'.repeat(64) }] },
  ]) assert.throws(() => validateCandidate({ ...candidate(), ...patch }, selected, policy));
  assert.throws(() => validateCandidate(candidate(), selected, null), /trust policy/);
  assert.throws(() => validateCandidate(candidate(), selected, { requireAuthenticode: true, signerThumbprints: [] }), /signer/);
  assert.throws(() => validateCandidate({ ...candidate(), authenticode: { required: true } }, selected,
    { requireAuthenticode: false, signerThumbprints: [] }), /signer/);
});

function installFixture({ manifest = candidate(), signature = { status: 'Valid', thumbprint: pins[0] },
  actualHash = 'b'.repeat(64), launchError, beforeInstall = true, downloadError, trust = policy } = {}) {
  let downloads = 0;
  let launches = 0;
  let verifications = 0;
  let backendStops = 0;
  const assets = [asset(installerName), asset('candidate-win32-x64.json')];
  const https = {
    request(_options, callback) {
      const request = Object.assign(new EventEmitter(), { end() {
        const response = Object.assign(new EventEmitter(), { statusCode: 200 });
        callback(response);
        queueMicrotask(() => {
          response.emit('data', JSON.stringify([release(`v${version}`, { assets })]));
          response.emit('end');
        });
      } });
      return request;
    },
  };
  const updater = loadUpdater({ packaged: true, modules: { 'node:https': https } });
  updater.init({
    trustPolicy: trust,
    fetchCandidate: async () => manifest,
    fsImpl: {
      mkdirSync() {}, rmSync() {},
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 42 }),
    },
    hashFile: async () => actualHash,
    verifySignature: async () => { verifications++; return signature; },
    download: async (_url, _dest, _progress, maxBytes) => {
      downloads++;
      assert.equal(maxBytes, 42);
      if (downloadError) throw new Error('injected interrupted download');
    },
    beforeInstall: async () => { backendStops++; return beforeInstall; },
    launchInstaller: async () => { launches++; if (launchError) throw new Error('injected asynchronous spawn denial'); },
  });
  return { updater, counts: () => ({ downloads, launches, verifications, backendStops }) };
}

test('verified installer alone crosses the injected execution boundary after exact checksum/signature and backend gate', async () => {
  const { updater, counts } = installFixture();
  await updater.checkForUpdates(true);
  assert.equal(updater.getState().canAutoInstall, true);
  await updater.downloadUpdate();
  assert.equal(updater.getState().status, 'restarting');
  assert.equal(counts().launches, 1);
  assert.equal(counts().backendStops, 1);
  assert.equal(counts().verifications, 2, 'revalidate downloaded bytes/signature before executing');
  updater.dispose();
});

test('hash mismatch, unsigned/foreign signer, interrupted download and pending evidence never execute installers', async () => {
  for (const options of [
    { actualHash: 'c'.repeat(64) },
    { signature: { status: 'NotSigned', thumbprint: pins[0] } },
    { signature: { status: 'Valid', thumbprint: 'd'.repeat(40) } },
    { manifest: { ...candidate(), qualification: 'pending' } },
    { downloadError: true },
  ]) {
    const { updater, counts } = installFixture(options);
    await updater.checkForUpdates(true);
    await updater.downloadUpdate();
    assert.equal(counts().launches, 0);
    assert.equal(counts().backendStops, 0);
    assert.equal(updater.getState().status, 'error');
    assert.match(updater.getState().error, /No unverified installer was started/);
    assert.equal(await updater.installNow(), false);
    assert.equal(counts().launches, 0);
    updater.dispose();
  }
});

test('installer launch rejection or unconfirmed backend stop is not reported as a successful install', async () => {
  for (const options of [{ launchError: true }, { beforeInstall: false }]) {
    const { updater, counts } = installFixture(options);
    await updater.checkForUpdates(true);
    assert.equal(await updater.installNow(), false);
    assert.notEqual(updater.getState().status, 'restarting');
    assert.match(updater.getState().error, /could not start or could not be verified/);
    if (options.beforeInstall === false) assert.equal(counts().launches, 0);
    updater.dispose();
  }
});

test('a pinned full Authenticode subject supports certificate rotation without trusting manifest-supplied signers', async () => {
  const trusted = 'CN=Fixture Publisher, O=Fixture Organization, C=US';
  for (const [subject, expected] of [[trusted, 1], ['CN=Different Publisher, C=US', 0]]) {
    const { updater, counts } = installFixture({
      trust: { requireAuthenticode: true, signerSubjects: [trusted] },
      signature: { status: 'Valid', thumbprint: 'c'.repeat(40), subject },
      manifest: { ...candidate(), authenticode: { required: true, signerSubjects: [subject] } },
    });
    await updater.checkForUpdates(true);
    await updater.downloadUpdate();
    assert.equal(counts().launches, expected);
    updater.dispose();
  }
});

test('the production downloader rejects oversized streams and non-HTTPS redirects without writing executables', async () => {
  const { Readable, Writable } = require('node:stream');
  let destination;
  const downloader = (redirect) => loadUpdater({ modules: {
    'node:fs': { createWriteStream() {
      destination = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      return destination;
    } },
    'node:https': { get(_url, _options, callback) {
      const request = new EventEmitter();
      queueMicrotask(() => {
        const response = Readable.from([Buffer.alloc(43)]);
        response.statusCode = redirect ? 302 : 200;
        response.headers = redirect ? { location: 'http://untrusted.invalid/a.exe' } : {};
        callback(response);
      });
      return request;
    } },
  } });
  await assert.rejects(downloader(false).downloadFile('https://trusted.invalid/a.exe', 'unused', () => {}, 42),
    /exceeds the release candidate size/);
  assert.equal(destination.destroyed, true);
  await assert.rejects(downloader(true).downloadFile('https://trusted.invalid/a.exe', 'unused', () => {}, 42),
    /redirects/);
});
