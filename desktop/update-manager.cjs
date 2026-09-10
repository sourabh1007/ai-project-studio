'use strict';

/**
 * Auto-update manager for the AI Project Studio desktop shell.
 *
 * Design goals (see docs/development.md ▸ "Auto-update"):
 *  - Windows (signed NSIS): `electron-updater` detects releases, but installation
 *    is guided because its public API cannot await installer-launch success
 *    before scheduling quit.
 *  - macOS (currently unsigned, DMG-only): `electron-updater`'s mac path needs a
 *    signed `zip` artifact, so instead we do a lightweight GitHub Releases check
 *    (detect + release notes) and a *guided* install (open the release page).
 *    `canAutoInstall=false` is surfaced so the UI communicates this honestly.
 *
 * Everything here is defensive: no update failure is ever allowed to break the
 * app. Errors become a non-fatal state pushed to the renderer. The whole module
 * is a no-op unless the app is packaged (or `CW_UPDATE_SIM=1` for local dev
 * testing against the real public feed).
 */

const { app, shell } = require('electron');
const https = require('node:https');

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
  ERROR: 'error',
};

let deps = null;
let electronUpdater = null;
let started = false;
let intervalTimer = null;
let downloaded = false;
let installing = null;

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
    // electron-updater's public quitAndInstall API cannot confirm asynchronous
    // NSIS launch before it schedules app.quit. Use guided installation until
    // a supported, awaited launch receipt is available.
    canAutoInstall: false,
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
 * Installation is guided: opening the release page never quits this process
 * or launches an installer behind the backend ownership gate.
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
  if (!active()) {
    return getState();
  }
  try {
    // Detection always goes through the GitHub Releases API, on every platform.
    // electron-updater's feed needs `latest.yml` published beside the
    // installers, and the release workflow deliberately uploads only the .exe /
    // .dmg (see .github/workflows/release.yml, "publish installers without
    // update feeds"). Asking electron-updater to check therefore 404s, and a
    // background 404 is swallowed — which is why no update ever announced
    // itself. The Releases API needs no feed, so it works either way.
    await checkGitHubLatest(manual);
  } catch (err) {
    // Background failures (e.g. offline) shouldn't nag; only show on manual.
    if (manual) {
      reportError(err);
    } else {
      log(`background check failed: ${err}`);
    }
  }
  return getState();
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
function checkGitHubLatest(manual) {
  return new Promise((resolve, reject) => {
    setState({ status: Status.CHECKING, error: null });
    const req = https.request(
      {
        method: 'GET',
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`,
        headers: {
          'User-Agent': 'ai-project-studio-updater',
          Accept: 'application/vnd.github+json',
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            if (!res.statusCode || res.statusCode >= 400) {
              throw new Error(`GitHub API returned ${res.statusCode}`);
            }
            const best = newestRelease(JSON.parse(body));
            if (best && isNewer(best.version, safeVersion())) {
              const json = best.release;
              setState({
                status: Status.AVAILABLE,
                availableVersion: best.version,
                releaseNotes: typeof json.body === 'string' ? json.body : null,
                releaseName: json.name || null,
                releasePageUrl: json.html_url || RELEASES_PAGE,
                error: null,
              });
            } else {
              setState({ status: Status.NOT_AVAILABLE, availableVersion: null, error: null });
            }
            resolve();
          } catch (err) {
            if (manual) {
              reportError(err);
            }
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('GitHub API request timed out')));
    req.on('error', (err) => {
      if (manual) {
        reportError(err);
      }
      reject(err);
    });
    req.end();
  });
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

/** Opens the release page for a user-managed download on supported platforms. */
async function downloadUpdate() {
  if (!active()) {
    return getState();
  }
  try {
    await shell.openExternal(state?.releasePageUrl || RELEASES_PAGE);
  } catch (err) {
    reportError(err);
  }
  return getState();
}

/**
 * Opens the release page for guided installation. A true result acknowledges
 * only the page-opening request, never installation or permission to quit.
 * Downloaded artifacts remain untouched and retry does not start an installer.
 */
function installNow() {
  if (!active()) {
    return Promise.resolve(false);
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
  Status,
};
