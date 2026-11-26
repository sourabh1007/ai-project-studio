'use strict';

/**
 * Auto-update manager for the AI Project Studio desktop shell.
 *
 * Design goals (see docs/development.md ▸ "Auto-update"):
 *  - Windows (NSIS): exact qualified release provenance, SHA-256 and a locally
 *    pinned Authenticode signer gate installation, followed by backend shutdown
 *    and an awaited installer spawn receipt. Missing trust fails closed.
 *  - macOS (currently unsigned, DMG-only): `electron-updater`'s mac path needs a
 *    signed `zip` artifact, so instead we do a lightweight GitHub Releases check
 *    (detect + release notes) and a *guided* install (open the release page).
 *    `canAutoInstall=false` is surfaced so the UI communicates this honestly.
 *
 * Everything here is defensive: no update failure is ever allowed to break the
 * app. Errors become a non-fatal state pushed to the renderer. Automatic checks
 * require a packaged app (or `CW_UPDATE_SIM=1`); source builds support explicit
 * release checks and guided installation only.
 */

const { app, shell } = require('electron');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream');

const GITHUB_OWNER = 'sourabh1007';
const GITHUB_REPO = 'ai-project-studio';
const RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const INITIAL_CHECK_DELAY_MS = 8000;

/** UI-facing status values. Mirrors ui/src/lib/update-state.ts. */
const Status = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  NOT_AVAILABLE: 'not-available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  INSTALLING: 'installing',
  RESTARTING: 'restarting',
  ERROR: 'error',
};

let deps = null;
let electronUpdater = null;
let started = false;
let intervalTimer = null;
let downloaded = false;
let installing = null;
// Windows seamless auto-update: the installer asset from the newest release,
// its downloaded local path, and an in-flight download guard.
let installerAsset = null;
let installerPath = null;
let downloading = null;
let installerCandidate = null;
let checking = null;
let checkingManually = false;
const RECOVERY = 'No unverified installer was started. Keep the app open, retry, or download a verified installer from the release page.';

// The single source of truth for the update state, echoed to the renderer on
// every change and returned by `getState()` for late-subscribing views.
let state = null;

function baseState() {
  return {
    status: Status.IDLE,
    currentVersion: safeVersion(),
    availableVersion: null,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    releaseNotes: null,
    releaseName: null,
    error: null,
    // Enabled only after an exact asset/manifest and packaged signer policy are
    // available. The install boundary still verifies their actual evidence.
    canAutoInstall: false,
    autoInstallBlockReason: null,
    platform: process.platform,
    releasePageUrl: RELEASES_PAGE,
  };
}

function safeVersion() {
  try {
    return app.getVersion();
  } catch {
    return '';
  }
}

function active() {
  try {
    return app.isPackaged || process.env.CW_UPDATE_SIM === '1';
  } catch {
    return false;
  }
}

function isWindows() {
  return process.platform === 'win32';
}

/** Merges a partial update into the state and pushes it to the renderer. */
function setState(patch) {
  state = { ...(state ?? baseState()), ...patch };
  send('update:event', state);
}

/** Best-effort send to the current top-level window's renderer. */
function send(channel, payload) {
  try {
    const win = deps && typeof deps.getWindow === 'function' ? deps.getWindow() : null;
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch {
    /* a missing/destroyed window must never throw into update logic */
  }
}

function log(message) {
  try {
    process.stderr.write(`[updater] ${message}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Initializes the manager. Safe to call once from `bootstrap()` after the
 * window exists. `deps.getWindow` returns the current BrowserWindow (or null);
 * `beforeInstall` must confirm owned backend shutdown. Unsupported targets use
 * the release page and never launch a local installer.
 */
function init(options) {
  deps = options || {};
  state = baseState();

  if (!active()) {
    log('not packaged and CW_UPDATE_SIM unset — auto-update disabled');
    return;
  }

  if (isWindows()) {
    initWindows();
  }
  // macOS uses on-demand GitHub checks only (see checkGitHubLatest); no eager
  // electron-updater wiring, which would error on the unsigned/dmg build.

  // Kick off a first background check shortly after launch, then periodically.
  setTimeout(() => void checkForUpdates(false), INITIAL_CHECK_DELAY_MS).unref?.();
  intervalTimer = setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS);
  intervalTimer.unref?.();
  started = true;
}

function initWindows() {
  try {
    electronUpdater = require('electron-updater');
    const au = electronUpdater.autoUpdater;
    // Neither the implicit quit hook nor quitAndInstall provides an awaited
    // NSIS launch receipt. Do not start an installer from either path.
    au.autoDownload = false;
    au.autoInstallOnAppQuit = false;
    au.logger = { info: log, warn: log, error: log, debug: () => {} };
    // In dev-sim mode, force the update check to run despite !isPackaged.
    if (!app.isPackaged) {
      au.forceDevUpdateConfig = true;
    }

    au.on('checking-for-update', () => setState({ status: Status.CHECKING, error: null }));
    au.on('update-available', (info) =>
      setState({
        status: Status.AVAILABLE,
        availableVersion: info?.version ?? null,
        releaseNotes: normalizeNotes(info?.releaseNotes),
        releaseName: info?.releaseName ?? null,
        error: null,
      }),
    );
    au.on('update-not-available', () =>
      setState({ status: Status.NOT_AVAILABLE, availableVersion: null, error: null }),
    );
    au.on('download-progress', (p) =>
      setState({
        status: Status.DOWNLOADING,
        percent: Math.max(0, Math.min(100, p?.percent ?? 0)),
        transferred: p?.transferred ?? 0,
        total: p?.total ?? 0,
        bytesPerSecond: p?.bytesPerSecond ?? 0,
      }),
    );
    au.on('update-downloaded', (info) => {
      downloaded = true;
      setState({
        status: Status.DOWNLOADED,
        percent: 100,
        availableVersion: info?.version ?? state?.availableVersion ?? null,
        releaseNotes: normalizeNotes(info?.releaseNotes) ?? state?.releaseNotes ?? null,
      });
    });
    au.on('error', (err) => {
      if (installing) {
        setState({ status: downloaded ? Status.DOWNLOADED : Status.ERROR,
          error: 'Update installation failed. Keep the app open and retry installation.' });
      } else {
        reportError(err);
      }
    });
  } catch (err) {
    log(`failed to init electron-updater: ${err}`);
    electronUpdater = null;
  }
}

function normalizeNotes(notes) {
  if (!notes) {
    return null;
  }
  if (typeof notes === 'string') {
    return notes;
  }
  // electron-updater can return an array of { version, note } entries.
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : n?.note))
      .filter(Boolean)
      .join('\n\n');
  }
  return null;
}

function reportError(err) {
  const message = err && err.message ? err.message : String(err ?? 'Unknown update error');
  log(`error: ${message}`);
  setState({ status: Status.ERROR, error: message });
}

/**
 * Checks for an update. `manual=true` surfaces "you're up to date" / errors to
 * the user; background checks stay quiet on the not-available path.
 */
async function checkForUpdates(manual) {
  if ((!active() && !manual) || downloading || installing) {
    return getState();
  }
  if (checking) {
    checkingManually ||= manual;
    return checking;
  }
  checkingManually = manual;
  const previous = getState();
  const attempt = (async () => {
    try {
      // Published releases omit electron-updater feeds; use GitHub metadata.
      await checkGitHubLatest();
    } catch (err) {
      if (checkingManually) {
        reportError(err);
      } else {
        log(`background check failed: ${err}`);
        setState(previous);
      }
    }
    return getState();
  })();
  checking = attempt;
  try {
    return await attempt;
  } finally {
    if (checking === attempt) checking = null;
  }
}

/**
 * Picks the newest published release from the Releases list. The list endpoint
 * is used rather than `/releases/latest` because releases ship as prereleases
 * marked `--latest=false`, which `/releases/latest` skips entirely — so that
 * endpoint reported "up to date" no matter how many versions had shipped.
 * Drafts are ignored; they are not downloadable.
 */
function newestRelease(releases) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) {
      continue;
    }
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (!version) {
      continue;
    }
    if (!best || isNewer(version, best.version)) {
      best = { version, release };
    }
  }
  return best;
}

/**
 * Lightweight GitHub Releases check. Never throws to the caller path beyond the
 * awaited promise; compares the newest published tag to the running version.
 */
function checkGitHubLatest(useFeed = false) {
  return new Promise((resolve, reject) => {
    setState({ status: Status.CHECKING, canAutoInstall: false, autoInstallBlockReason: null, error: null });
    const req = https.request(
      {
        method: 'GET',
        hostname: useFeed ? 'github.com' : 'api.github.com',
        path: useFeed ? `/${GITHUB_OWNER}/${GITHUB_REPO}/releases.atom`
          : `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`,
        headers: {
          'User-Agent': 'ai-project-studio-updater',
          Accept: useFeed ? 'application/atom+xml' : 'application/vnd.github+json',
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2 * 1024 * 1024) {
            res.destroy(new Error('GitHub release response exceeds its size limit.'));
          } else {
            body += chunk;
          }
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('GitHub API response was interrupted. Retry checking for updates.')));
        res.on('end', async () => {
          try {
            if (!useFeed && [403, 429].includes(res.statusCode)) {
              resolve(checkGitHubLatest(true));
              return;
            }
            if (!res.statusCode || res.statusCode >= 400) {
              throw new Error(`GitHub ${useFeed ? 'release feed' : 'API'} returned ${res.statusCode}`);
            }
            const best = newestRelease(useFeed ? parseReleaseFeed(body) : JSON.parse(body));
            if (best && isNewer(best.version, safeVersion())) {
              const json = best.release;
              const next = pickWindowsInstaller(json.assets, best.version, process.arch);
              const autoInstallBlockReason = useFeed
                ? 'GitHub API is rate-limited. Release discovered via the public feed; open the release page for guided installation.'
                : await automaticInstallBlockReason(next);
              if (installerAsset?.url !== next?.url) {
                installerPath = null;
                installerCandidate = null;
                downloaded = false;
              }
              installerAsset = next;
              setState({
                status: Status.AVAILABLE,
                availableVersion: best.version,
                releaseNotes: typeof json.body === 'string' ? json.body : null,
                releaseName: json.name || null,
                releasePageUrl: json.html_url || RELEASES_PAGE,
                canAutoInstall: autoInstallBlockReason === null,
                autoInstallBlockReason,
                error: null,
              });
            } else {
              installerAsset = null;
              setState({
                status: Status.NOT_AVAILABLE,
                availableVersion: null,
                canAutoInstall: false,
                autoInstallBlockReason: null,
                error: null,
              });
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('GitHub API request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function parseReleaseFeed(body) {
  if (!/<feed(?:\s|>)/.test(body) || !/<\/feed>/.test(body)) {
    throw new Error('GitHub release feed is invalid. Retry checking for updates.');
  }
  const prefix = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/`;
  const releases = [];
  const entries = [...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)];
  for (const [, entry] of entries) {
    const link = [...entry.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*\/?>/g)]
      .find((match) => match[1].startsWith(prefix));
    if (!link) continue;
    const tag = link[1].slice(prefix.length);
    if (!/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) continue;
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || tag;
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    releases.push({
      tag_name: tag, html_url: link[1],
      name: title.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => entities[entity]),
    });
  }
  if (entries.length && !releases.length) {
    throw new Error('GitHub release feed has no usable version tags. Retry checking for updates.');
  }
  return releases;
}

/** True when semver-ish `a` (x.y.z[-pre]) is strictly newer than `b`. */
function isNewer(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) {
      return pa.nums[i] > pb.nums[i];
    }
  }
  // Equal core: a stable release is newer than a prerelease of the same core.
  if (pa.pre === pb.pre) {
    return false;
  }
  if (!pa.pre) {
    return true;
  }
  if (!pb.pre) {
    return false;
  }
  return pa.pre > pb.pre;
}

function parseVersion(v) {
  const [core, pre] = String(v).split('-');
  const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) {
    nums.push(0);
  }
  return { nums: nums.slice(0, 3), pre: pre || '' };
}

/** Chooses the Windows NSIS installer (.exe) asset from a release's assets. */
function pickWindowsInstaller(assets, version, arch = process.arch) {
  if (!Array.isArray(assets)) {
    return null;
  }
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '') ||
      !['x64', 'arm64'].includes(arch)) return null;
  const name = `AI-Project-Studio-${version}-win-${arch}.exe`;
  const expectedUrl = (file) =>
    `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/${file}`;
  const matches = assets.filter((asset) => asset?.name === name);
  if (matches.length !== 1 || matches[0].browser_download_url !== expectedUrl(name)) return null;
  const candidateName = `candidate-win32-${arch}.json`;
  const candidates = assets.filter((asset) => asset?.name === candidateName);
  return {
    url: expectedUrl(name), name, version, platform: 'win32', arch,
    candidateUrl: candidates.length === 1 && candidates[0].browser_download_url === expectedUrl(candidateName)
      ? expectedUrl(candidateName) : null,
  };
}

function trustPolicy() {
  if (deps?.trustPolicy) return deps.trustPolicy;
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).updateTrust;
  } catch {
    return null;
  }
}

function hasSignerPolicy() {
  const policy = trustPolicy();
  return !!policy && (policy.requireAuthenticode === false ||
    (policy.requireAuthenticode === true && hasTrustedSigner(policy)));
}

async function automaticInstallBlockReason(asset) {
  if (!active()) return 'Source builds use guided updates. Open the release page or update your checkout; no installer will be started automatically.';
  if (!isWindows()) return 'This platform uses guided installation. Open the release page; the app will remain open.';
  if (!asset) return 'No exact installer is available for this version and architecture. Open the release page for supported downloads.';
  if (!hasSignerPolicy()) return 'Trusted Authenticode signer pins are not configured in this app. Contact the release maintainer; use the release page for guided installation.';
  if (!asset.candidateUrl) return 'The exact release qualification manifest is missing. Contact the release maintainer; use the release page for guided installation.';
  try {
    validateCandidate(await (deps?.fetchCandidate || fetchCandidate)(asset.candidateUrl), asset, trustPolicy());
    return null;
  } catch (error) {
    return `${error.message} Open the release page for guided installation; no installer will be started automatically.`;
  }
}

function hasTrustedSigner(policy) {
  const pins = policy.signerThumbprints;
  const subjects = policy.signerSubjects;
  return (Array.isArray(pins) && pins.length > 0 &&
    pins.every((value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))) ||
    (Array.isArray(subjects) && subjects.length > 0 &&
      subjects.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
        /(?:^|,\s*)CN=[^,]+/.test(value) && !/[\x00-\x1f]/.test(value)));
}

function validateCandidate(candidate, asset, policy) {
  if (!candidate || candidate.schemaVersion !== 1 || candidate.qualification !== 'passed' ||
      candidate.version !== asset.version || candidate.platform !== asset.platform || candidate.arch !== asset.arch) {
    throw new Error('Release candidate is missing, unqualified, or does not match this version/platform/architecture.');
  }
  const matches = Array.isArray(candidate.artifacts) ? candidate.artifacts.filter((item) => item?.name === asset.name) : [];
  const artifact = matches[0];
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? '') ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > 2 * 1024 ** 3) {
    throw new Error('Release candidate has no exact bounded installer checksum.');
  }
  if (!policy || typeof policy.requireAuthenticode !== 'boolean') throw new Error('Packaged update trust policy is missing.');
  const signed = policy.requireAuthenticode || candidate.authenticode?.required === true;
  if (signed && (candidate.signatureVerification !== 'passed' || !hasTrustedSigner(policy))) {
    throw new Error('Trusted Authenticode signer pins or qualified signature evidence are missing. Contact the release maintainer.');
  }
  return {
    ...artifact, signed,
    signerThumbprints: Array.isArray(policy.signerThumbprints) ? policy.signerThumbprints : [],
    signerSubjects: Array.isArray(policy.signerSubjects) ? policy.signerSubjects : [],
  };
}

function fetchCandidate(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!url || new URL(url).protocol !== 'https:' || redirects > 5) {
      reject(new Error('A trusted HTTPS release candidate manifest is required.'));
      return;
    }
    const request = https.get(url, { headers: { 'User-Agent': 'ai-project-studio-updater' }, timeout: 15000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(fetchCandidate(new URL(response.headers.location, url).href, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Release candidate manifest is unavailable.')); return; }
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) response.destroy(new Error('Release candidate manifest exceeds its limit.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Release candidate response was interrupted.')));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Release candidate request timed out.')));
    request.on('error', reject);
  });
}

async function hashInstaller(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function verifyAuthenticode(file) {
  return new Promise((resolve, reject) => {
    const script = `$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; ` +
      `@{status=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint;subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30000, maxBuffer: 65536 }, (error, stdout) => {
        if (error) { reject(new Error('Authenticode verification could not complete.')); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Authenticode verification returned invalid evidence.')); }
      });
  });
}

async function verifyInstaller(file, candidate) {
  const io = deps?.fsImpl || fs;
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.bytes ||
      (await (deps?.hashFile || hashInstaller)(file)).toLowerCase() !== candidate.sha256.toLowerCase()) {
    throw new Error('Installer size or SHA-256 does not match the trusted release candidate.');
  }
  if (candidate.signed) {
    const signature = await (deps?.verifySignature || verifyAuthenticode)(file);
    const pinned = typeof signature?.thumbprint === 'string' && candidate.signerThumbprints.some((pin) =>
      typeof pin === 'string' && pin.toLowerCase() === signature.thumbprint.toLowerCase());
    const subject = typeof signature?.subject === 'string' && candidate.signerSubjects.some((value) =>
      typeof value === 'string' && value === signature.subject);
    if (signature?.status !== 'Valid' || (!pinned && !subject)) {
      throw new Error('Installer Authenticode signature is invalid or its signer is not trusted.');
    }
  }
}

/**
 * Primary "update" action.
 *  - Windows with a downloadable installer: download it in the background
 *    (streaming progress to the banner) and, on completion, silently install
 *    and relaunch — the whole flow from a single click, no further prompts.
 *  - Everything else (macOS / no asset): guided install by opening the page.
 */
async function downloadUpdate() {
  if ((!active() && !state?.availableVersion) || checking) {
    return getState();
  }
  if (active() && isWindows() && state?.canAutoInstall && installerAsset && installerAsset.url) {
    return downloadAndInstallWindows();
  }
  try {
    await shell.openExternal(state?.releasePageUrl || RELEASES_PAGE);
  } catch (err) {
    reportError(err);
  }
  return getState();
}

/**
 * Downloads the Windows installer to a private file with live progress, then hands
 * off to the silent installer. Guarded so repeated clicks share one download.
 */
function downloadAndInstallWindows() {
  if (downloading) {
    return downloading;
  }
  downloading = (async () => {
    let dest;
    try {
      const asset = installerAsset;
      const candidate = validateCandidate(
        await (deps?.fetchCandidate || fetchCandidate)(asset.candidateUrl), asset, trustPolicy());
      const io = deps?.fsImpl || fs;
      const directory = path.join(app.getPath('userData'), 'updates', randomUUID());
      io.mkdirSync(directory, { recursive: true, mode: 0o700 });
      dest = path.join(directory, asset.name);
      setState({
        status: Status.DOWNLOADING,
        percent: 0,
        transferred: 0,
        total: 0,
        error: null,
      });
      await (deps?.download || downloadFile)(asset.url, dest, (transferred, total) => {
        setState({
          status: Status.DOWNLOADING,
          transferred,
          total,
          percent:
            total > 0
              ? Math.max(0, Math.min(100, (transferred / total) * 100))
              : state?.percent ?? 0,
        });
      }, candidate.bytes);
      await verifyInstaller(dest, candidate);
      if (asset !== installerAsset) throw new Error('The available release changed during download. Retry the current update.');
      installerPath = dest;
      installerCandidate = candidate;
      downloaded = true;
      setState({ status: Status.DOWNLOADED, percent: 100, error: null });
      // Seamless finish: install + relaunch in the background.
      await runSilentInstall();
    } catch (err) {
      if (dest) {
        try { (deps?.fsImpl || fs).rmSync(path.dirname(dest), { recursive: true, force: true }); } catch { /* private failed download */ }
      }
      installerPath = null;
      installerCandidate = null;
      downloaded = false;
      reportError(new Error(`${err.message} ${RECOVERY}`));
    }
    return getState();
  })();
  const attempt = downloading;
  void attempt.then(() => {
    if (downloading === attempt) {
      downloading = null;
    }
  });
  return attempt;
}

/** Streams a URL to a local file, following redirects and reporting progress. */
function downloadFile(url, dest, onProgress, maxBytes, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (new URL(url).protocol !== 'https:' || redirects > 5) {
      reject(new Error('Too many redirects while downloading the update'));
      return;
    }
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ai-project-studio-updater',
          Accept: 'application/octet-stream',
        },
        timeout: 60000,
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          resolve(downloadFile(new URL(location, url).href, dest, onProgress, maxBytes, redirects + 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`Update download failed with HTTP ${status}`));
          return;
        }
        const total = Number.parseInt(res.headers['content-length'] || '0', 10) || 0;
        if (total && total !== maxBytes) {
          res.resume();
          reject(new Error('Update download length differs from the release candidate'));
          return;
        }
        let transferred = 0;
        const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
        res.on('data', (chunk) => {
          transferred += chunk.length;
          if (transferred > maxBytes) {
            const error = new Error('Update download exceeds the release candidate size');
            out.destroy(error);
            res.destroy(error);
            return;
          }
          try {
            onProgress(transferred, total);
          } catch {
            /* progress reporting must never break the download */
          }
        });
        res.on('aborted', () => out.destroy(new Error('Update download was interrupted')));
        pipeline(res, out, (error) => error ? reject(error) : resolve());
      },
    );
    req.on('timeout', () => req.destroy(new Error('Update download timed out')));
    req.on('error', reject);
  });
}

/**
 * Launches the downloaded NSIS installer silently and quits so it can swap the
 * binaries; `--force-run` relaunches the app afterwards. Mirrors what
 * electron-updater does internally, but for a manually-fetched asset.
 */
function runSilentInstall() {
  if (installing) return installing;
  const attempt = performSilentInstall();
  installing = attempt;
  void attempt.then(() => { if (installing === attempt) installing = null; });
  return attempt;
}

async function performSilentInstall() {
  if (!isWindows() || !installerPath || !installerCandidate) {
    return false;
  }
  const file = installerPath;
  const candidate = installerCandidate;
  try {
    await verifyInstaller(file, candidate);
    if (typeof deps?.beforeInstall !== 'function' || await deps.beforeInstall() !== true) {
      throw new Error('Backend shutdown was not confirmed.');
    }
    // Surface the install phase so the banner animates an honest "Installing…"
    // state instead of a frozen 100% bar while NSIS swaps the binaries.
    setState({ status: Status.INSTALLING, percent: 100, error: null });
    await (deps?.launchInstaller || ((file) => new Promise((resolve, reject) => {
      const child = spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    })))(file);
    // The installer is attaching; tell the UI we're about to relaunch so it can
    // show a calm "Restarting…" message with a spinner right up to the quit.
    setState({ status: Status.RESTARTING, percent: 100, error: null });
    // Give the installer a moment to attach, then quit so it can replace files.
    setTimeout(() => {
      try {
        app.quit();
      } catch {
        /* ignore */
      }
    }, 1200).unref?.();
    return true;
  } catch (err) {
    log(`silent install error: ${err}`);
    try { deps?.onInstallFailure?.(); } catch { /* recovery cannot hide the install error */ }
    setState({
      status: Status.DOWNLOADED,
      error: `Automatic installation could not start or could not be verified. ${RECOVERY} If the backend has stopped, restart the app before retrying.`,
    });
    return false;
  }
}

/**
 * Install action.
 *  - Windows: run the silent installer if the update is already downloaded, or
 *    download-then-install if the user reached here first.
 *  - Everything else: guided install by opening the release page. A true result
 *    acknowledges only the page-opening request, never a forced quit.
 */
function installNow() {
  if ((!active() && !state?.availableVersion) || checking) {
    return Promise.resolve(false);
  }
  if (active() && isWindows() && state?.canAutoInstall && installerAsset) {
    if (installerPath) {
      return runSilentInstall();
    }
    return downloadAndInstallWindows()
      .then(() => getState().status === Status.RESTARTING)
      .catch(() => false);
  }
  if (installing) {
    return installing;
  }
  installing = (async () => {
    try {
      await shell.openExternal(state?.releasePageUrl || RELEASES_PAGE);
      setState({ error: null });
      return true;
    } catch {
      const message = 'Could not open the release page. No installer was started and the app will remain open. Retry opening the release page.';
      log(message);
      setState({ status: downloaded ? Status.DOWNLOADED : Status.ERROR, error: message });
      return false;
    }
  })();
  const attempt = installing;
  void attempt.then(() => { if (installing === attempt) installing = null; });
  return attempt;
}

function hasPendingInstall() {
  return false;
}

function getState() {
  return state ?? baseState();
}

function dispose() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  started = false;
}

module.exports = {
  init,
  checkForUpdates,
  downloadUpdate,
  installNow,
  hasPendingInstall,
  getState,
  dispose,
  // Exported for potential reuse/testing.
  isNewer,
  newestRelease,
  pickWindowsInstaller,
  validateCandidate,
  verifyInstaller,
  downloadFile,
  Status,
};
