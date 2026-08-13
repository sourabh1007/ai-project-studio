'use strict';

/**
 * Auto-update manager for the AI Project Studio desktop shell.
 *
 * Design goals (see docs/development.md ▸ "Auto-update"):
 *  - Windows (signed NSIS): full `electron-updater` flow — detect, notify,
 *    user-consented download with live progress (differential/blockmap), then
 *    one-click install via `quitAndInstall`.
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
    canAutoInstall: process.platform === 'win32',
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
 * `deps.stopBackend` gracefully stops the spawned backend before relaunch.
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
    // User consents to downloads; a deferred update still applies on next quit.
    au.autoDownload = false;
    au.autoInstallOnAppQuit = true;
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
    au.on('update-downloaded', (info) =>
      setState({
        status: Status.DOWNLOADED,
        percent: 100,
        availableVersion: info?.version ?? state?.availableVersion ?? null,
        releaseNotes: normalizeNotes(info?.releaseNotes) ?? state?.releaseNotes ?? null,
      }),
    );
    au.on('error', (err) => reportError(err));
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
    if (isWindows() && electronUpdater) {
      setState({ status: Status.CHECKING, error: null });
      await electronUpdater.autoUpdater.checkForUpdates();
    } else {
      await checkGitHubLatest(manual);
    }
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
 * Lightweight GitHub Releases check used on macOS (and any non-Windows). Never
 * throws to the caller path beyond the awaited promise; compares the latest
 * published tag to the running version.
 */
function checkGitHubLatest(manual) {
  return new Promise((resolve, reject) => {
    setState({ status: Status.CHECKING, error: null });
    const req = https.request(
      {
        method: 'GET',
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
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
            const json = JSON.parse(body);
            const tag = String(json.tag_name || '').replace(/^v/, '');
            const notes = typeof json.body === 'string' ? json.body : null;
            if (tag && isNewer(tag, safeVersion())) {
              setState({
                status: Status.AVAILABLE,
                availableVersion: tag,
                releaseNotes: notes,
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

/** Starts the user-consented download (Windows). No-op elsewhere. */
async function downloadUpdate() {
  if (!active()) {
    return getState();
  }
  try {
    if (isWindows() && electronUpdater) {
      setState({ status: Status.DOWNLOADING, percent: 0, error: null });
      await electronUpdater.autoUpdater.downloadUpdate();
    } else {
      // macOS guided path: open the release page so the user grabs the signed
      // DMG. (In-app auto-install requires Apple code signing — not available.)
      await shell.openExternal(state?.releasePageUrl || RELEASES_PAGE);
    }
  } catch (err) {
    reportError(err);
  }
  return getState();
}

/**
 * Installs a downloaded update. Signals the renderer to persist work, stops the
 * backend cleanly, then relaunches into the installer. On macOS this opens the
 * downloaded/release artifact for a guided install instead.
 */
function installNow() {
  if (!active()) {
    return;
  }
  try {
    send('update:before-quit', { at: Date.now() });
    if (isWindows() && electronUpdater) {
      // Give the renderer a beat to flush, then quit into the installer.
      setTimeout(() => {
        try {
          if (deps && typeof deps.stopBackend === 'function') {
            deps.stopBackend();
          }
          electronUpdater.autoUpdater.quitAndInstall(false, true);
        } catch (err) {
          reportError(err);
        }
      }, 250);
    } else {
      void shell.openExternal(state?.releasePageUrl || RELEASES_PAGE);
    }
  } catch (err) {
    reportError(err);
  }
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
  getState,
  dispose,
  // Exported for potential reuse/testing.
  isNewer,
  Status,
};
