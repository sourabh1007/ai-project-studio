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
    process: Object.assign(new EventEmitter(), { env: {}, platform: overrides.platform ?? 'win32', arch: 'x64' }),
    Buffer, URL,
    setTimeout: () => ({ unref() {} }),
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    require: (name) =>
      name === 'electron'
        ? { app, shell: { openExternal: overrides.openExternal ?? (() => {}) } }
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
  actualHash = 'b'.repeat(64), launchError, beforeInstall = true, downloadError, trust = policy,
  releaseAssets, candidateError, platform, releaseError, downloadGate, packaged = true, responseError,
  releaseStatus = 200, feedBody, feedStatus = 200 } = {}) {
  let downloads = 0;
  let launches = 0;
  let verifications = 0;
  let backendStops = 0;
  let manifestReads = 0;
  let releaseReads = 0;
  const openedPages = [];
  const requests = [];
  const assets = releaseAssets ?? [asset(installerName), asset('candidate-win32-x64.json')];
  const https = {
    request(options, callback) {
      releaseReads++;
      requests.push(options);
      const request = Object.assign(new EventEmitter(), { end() {
        if (releaseError) {
          queueMicrotask(() => request.emit('error', new Error(releaseError)));
          return;
        }
        const feed = options.hostname === 'github.com';
        const response = Object.assign(new EventEmitter(), {
          statusCode: feed ? feedStatus : typeof releaseStatus === 'function' ? releaseStatus() : releaseStatus,
          destroy(error) { this.emit('error', error); },
        });
        callback(response);
        queueMicrotask(() => {
          if (responseError) {
            response.emit(responseError === 'aborted' ? 'aborted' : 'error', new Error('injected response failure'));
            return;
          }
          response.emit('data', feed ? feedBody : JSON.stringify([release(`v${version}`, { assets })]));
          response.emit('end');
        });
      } });
      return request;
    },
  };
  const updater = loadUpdater({
    packaged, platform, modules: { 'node:https': https },
    openExternal: async (url) => { openedPages.push(url); },
  });
  updater.init({
    trustPolicy: trust,
    fetchCandidate: async () => {
      manifestReads++;
      if (candidateError) throw new Error(candidateError);
      return manifest;
    },
    fsImpl: {
      mkdirSync() {}, rmSync() {},
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 42 }),
    },
    hashFile: async () => actualHash,
    verifySignature: async () => { verifications++; return signature; },
    download: async (_url, _dest, _progress, maxBytes) => {
      downloads++;
      assert.equal(maxBytes, 42);
      await downloadGate;
      if (downloadError) throw new Error('injected interrupted download');
    },
    beforeInstall: async () => { backendStops++; return beforeInstall; },
    launchInstaller: async () => { launches++; if (launchError) throw new Error('injected asynchronous spawn denial'); },
  });
  return { updater, openedPages, requests, counts: () => ({ downloads, launches, verifications, backendStops, manifestReads, releaseReads }) };
}

const releaseFeed = (entries) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.map(
  ([tag, title = tag, owner = 'sourabh1007']) => `<entry><link rel="alternate" href="https://github.com/${owner}/ai-project-studio/releases/tag/${tag}"/><title>${title}</title></entry>`,
).join('')}</feed>`;

test('rate-limited update checks discover prereleases from the public feed and remain guided-only', async () => {
  for (const releaseStatus of [403, 429]) {
    const { updater, requests, counts, openedPages } = installFixture({
      releaseStatus, feedBody: releaseFeed([['v0.11.6'], ['v0.12.0', 'Preview &amp; notes']]),
    });
    await updater.checkForUpdates(true);
    assert.deepEqual(requests.map((request) => request.hostname), ['api.github.com', 'github.com']);
    assert.equal(updater.getState().status, 'available');
    assert.equal(updater.getState().availableVersion, version);
    assert.equal(updater.getState().releaseName, 'Preview & notes');
    assert.equal(updater.getState().canAutoInstall, false);
    assert.match(updater.getState().autoInstallBlockReason, /rate-limited/);
    await updater.downloadUpdate();
    assert.equal(await updater.installNow(), true);
    assert.ok(openedPages.every((url) => url.endsWith('/releases/tag/v0.12.0')));
    assert.equal(counts().downloads, 0);
    assert.equal(counts().launches, 0);
    assert.equal(counts().backendStops, 0);
    assert.equal(counts().manifestReads, 0);
    updater.dispose();
  }
});

test('feed fallback clears previous automatic readiness and ignores foreign or invalid release links', async () => {
  let status = 200;
  const { updater } = installFixture({
    releaseStatus: () => status,
    feedBody: releaseFeed([['v0.12.0'], ['v99.0.0', 'foreign', 'other'], ['not-a-version']]),
  });
  await updater.checkForUpdates(true);
  assert.equal(updater.getState().canAutoInstall, true);
  status = 403;
  await updater.checkForUpdates(true);
  assert.equal(updater.getState().availableVersion, version);
  assert.equal(updater.getState().canAutoInstall, false);
  updater.dispose();
});

test('feed fallback reports up-to-date releases but fails visibly for invalid or unavailable feeds', async () => {
  for (const [feedBody, feedStatus, expected] of [
    [releaseFeed([['v0.11.5']]), 200, 'not-available'],
    [releaseFeed([]), 200, 'not-available'],
    ['not XML', 200, 'error'],
    [releaseFeed([['unknown']]), 200, 'error'],
    [releaseFeed([]), 503, 'error'],
    ['x'.repeat(2 * 1024 * 1024 + 1), 200, 'error'],
  ]) {
    const { updater, counts } = installFixture({ releaseStatus: 403, feedBody, feedStatus });
    await updater.checkForUpdates(true);
    assert.equal(updater.getState().status, expected);
    assert.equal(updater.getState().canAutoInstall, false);
    assert.equal(counts().releaseReads, 2);
    if (expected === 'error') assert.match(updater.getState().error, /feed|size limit/);
    updater.dispose();
  }
  const { updater, counts } = installFixture({ releaseStatus: 500 });
  await updater.checkForUpdates(true);
  assert.equal(updater.getState().status, 'error');
  assert.equal(counts().releaseReads, 1, 'unrelated HTTP errors do not trigger a fallback loop');
  updater.dispose();
});

test('guided Windows actions open the release page without downloading or stopping the backend', async () => {
  const { updater, counts, openedPages } = installFixture({
    trust: { requireAuthenticode: true, signerThumbprints: [] },
  });
  await updater.checkForUpdates(true);
  assert.equal(updater.getState().canAutoInstall, false);
  assert.match(updater.getState().autoInstallBlockReason, /signer/i);
  await updater.downloadUpdate();
  assert.equal(await updater.installNow(), true);
  assert.equal(openedPages.length, 2);
  assert.ok(openedPages.every((url) => url === 'https://github.com/sourabh1007/ai-project-studio/releases/latest'));
  assert.deepEqual(counts(), { downloads: 0, launches: 0, verifications: 0, backendStops: 0, manifestReads: 0, releaseReads: 1 });
  assert.equal(updater.getState().status, 'available');
  updater.dispose();
});

test('manual checks work in source builds while background checks and automatic installation stay disabled', async () => {
  const { updater, counts, openedPages } = installFixture({ packaged: false });
  await updater.checkForUpdates(false);
  assert.equal(counts().releaseReads, 0);
  await updater.checkForUpdates(true);
  assert.equal(counts().releaseReads, 1);
  assert.equal(updater.getState().status, 'available');
  assert.equal(updater.getState().canAutoInstall, false);
  assert.match(updater.getState().autoInstallBlockReason, /Source builds/);
  await updater.downloadUpdate();
  assert.equal(await updater.installNow(), true);
  assert.equal(openedPages.length, 2);
  assert.equal(counts().downloads, 0);
  assert.equal(counts().backendStops, 0);
  assert.equal(counts().launches, 0);
  updater.dispose();
});

test('interrupted release responses fail visibly instead of leaving manual checks stuck', async () => {
  for (const responseError of ['error', 'aborted']) {
    const { updater } = installFixture({ responseError });
    await updater.checkForUpdates(true);
    assert.equal(updater.getState().status, 'error');
    assert.match(updater.getState().error, /response failure|interrupted/);
    updater.dispose();
  }
});
test('coalesces overlapping release checks and prevents installation during qualification checks', async () => {
  let finish;
  const manifest = new Promise((resolve) => { finish = resolve; });
  const { updater, counts, openedPages } = installFixture({ manifest });
  const first = updater.checkForUpdates(false);
  const second = updater.checkForUpdates(true);
  await new Promise(setImmediate);
  assert.equal(updater.getState().status, 'checking');
  assert.equal(updater.getState().canAutoInstall, false);
  assert.equal(await updater.installNow(), false);
  await updater.downloadUpdate();
  assert.equal(openedPages.length, 0);
  assert.equal(counts().downloads, 0);
  finish(candidate());
  await Promise.all([first, second]);
  assert.equal(counts().releaseReads, 1);
  assert.equal(counts().manifestReads, 1);
  assert.equal(updater.getState().canAutoInstall, true);
  await updater.checkForUpdates(true);
  assert.equal(counts().manifestReads, 2, 'readiness refreshes instead of trusting a cached manifest');
  updater.dispose();
});

test('background network failures restore a retryable state; manual checks surface the error', async () => {
  const { updater } = installFixture({ releaseError: 'Network unavailable' });
  await updater.checkForUpdates(false);
  assert.equal(updater.getState().status, 'idle');
  assert.equal(updater.getState().error, null);
  await Promise.all([updater.checkForUpdates(false), updater.checkForUpdates(true)]);
  assert.equal(updater.getState().status, 'error');
  assert.match(updater.getState().error, /Network unavailable/);
  updater.dispose();
});

test('release polling cannot replace download progress or installer state', async () => {
  let finish;
  const downloadGate = new Promise((resolve) => { finish = resolve; });
  const { updater, counts } = installFixture({ downloadGate });
  await updater.checkForUpdates(true);
  const download = updater.downloadUpdate();
  await new Promise(setImmediate);
  assert.equal(updater.getState().status, 'downloading');
  await updater.checkForUpdates(false);
  assert.equal(updater.getState().status, 'downloading');
  assert.equal(counts().releaseReads, 1);
  finish();
  await download;
  assert.equal(updater.getState().status, 'restarting');
  assert.equal(counts().launches, 1);
  updater.dispose();
});

test('automatic readiness requires a qualified exact manifest and explains guided fallback', async () => {
  for (const [options, reason] of [
    [{ manifest: { ...candidate(), qualification: 'pending' } }, /unqualified/],
    [{ manifest: { ...candidate(), signatureVerification: 'pending' } }, /signature evidence/],
    [{ manifest: { ...candidate(), arch: 'arm64' } }, /architecture/],
    [{ releaseAssets: [asset(installerName)] }, /manifest/],
    [{ releaseAssets: [] }, /installer/],
    [{ candidateError: 'Release candidate request timed out.' }, /timed out/],
    [{ platform: 'darwin' }, /guided/],
  ]) {
    const { updater, counts, openedPages } = installFixture(options);
    await updater.checkForUpdates(true);
    assert.equal(updater.getState().status, 'available');
    assert.equal(updater.getState().canAutoInstall, false);
    assert.match(updater.getState().autoInstallBlockReason, reason);
    assert.equal(await updater.installNow(), true);
    assert.equal(openedPages.length, 1);
    assert.equal(counts().downloads, 0);
    assert.equal(counts().backendStops, 0);
    assert.equal(counts().launches, 0);
    updater.dispose();
  }
});

test('verified installer alone crosses the injected execution boundary after exact checksum/signature and backend gate', async () => {
  const { updater, counts } = installFixture();
  await updater.checkForUpdates(true);
  assert.equal(updater.getState().canAutoInstall, true);
  assert.equal(updater.getState().autoInstallBlockReason, null);
  await updater.downloadUpdate();
  assert.equal(updater.getState().status, 'restarting');
  assert.equal(counts().launches, 1);
  assert.equal(counts().backendStops, 1);
  assert.equal(counts().verifications, 2, 'revalidate downloaded bytes/signature before executing');
  updater.dispose();
});

test('qualification is checked again before downloading instead of trusting release-check evidence', async () => {
  const manifest = candidate();
  const { updater, counts } = installFixture({ manifest });
  await updater.checkForUpdates(true);
  assert.equal(updater.getState().canAutoInstall, true);
  manifest.qualification = 'pending';
  await updater.downloadUpdate();
  assert.equal(counts().manifestReads, 2);
  assert.equal(counts().downloads, 0);
  assert.equal(counts().launches, 0);
  assert.match(updater.getState().error, /unqualified/);
  updater.dispose();
});

test('hash mismatch, unsigned/foreign signer and interrupted download never execute installers', async () => {
  for (const options of [
    { actualHash: 'c'.repeat(64) },
    { signature: { status: 'NotSigned', thumbprint: pins[0] } },
    { signature: { status: 'Valid', thumbprint: 'd'.repeat(40) } },
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
