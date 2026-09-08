'use strict';

const { app, BrowserWindow, Menu, shell, nativeTheme, ipcMain, session, clipboard, dialog, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const regression = require('./regression-isolation.cjs').configure(app);
const updateManager = regression?.updater || require('./update-manager.cjs');
const ipcInput = require('./ipc-input.cjs');
let clipboardAttachmentStore = null;
const {
  requestBackendShutdown,
  requestBackendShutdownIpc,
  waitForChildExit,
} = require('./backend-control.cjs');

// The current top-level app window. Captured in createWindow so the update
// manager (and any future feature) can push messages to the renderer.
let mainWindow = null;
let lastWindowUrl = null;

const ROOT = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, '..');
const BACKEND_ENTRY = regression?.backendEntry || path.join(ROOT, 'backend', 'dist', 'main.js');
const UI_DIST = path.join(ROOT, 'ui', 'dist');
const DOCS_DIR = path.join(ROOT, 'docs');
const DOCS_URL = 'https://github.com/sourabh1007/ai-project-studio/tree/main/docs';
const HOST = '127.0.0.1';
const IS_DEV = process.env.CW_DESKTOP_DEV === '1';
const DEV_URL = process.env.CW_DEV_URL || 'http://localhost:5173';

// The app icon, packaged next to main.cjs (see `files` in electron-builder.yml)
// so it resolves both in dev (desktop/build-resources) and inside app.asar. Used
// for the window/taskbar icon and the native About dialog. Loaded lazily and
// cached so a missing file degrades gracefully to the platform default.
const APP_ICON_PATH = path.join(__dirname, 'build-resources', 'icon.png');
let appIconImage;
function appIcon() {
  if (appIconImage === undefined) {
    const image = nativeImage.createFromPath(APP_ICON_PATH);
    appIconImage = image.isEmpty() ? null : image;
  }
  return appIconImage;
}

// Persisted UI theme, used to pick the window's launch background color so a
// light-theme user doesn't get a dark flash before the renderer paints. The
// renderer is the source of truth and pushes updates via the `theme:set` IPC.
const THEME_FILE = path.join(app.getPath('userData'), 'theme.json');
const THEME_BG = { dark: '#0b1020', light: '#eef2fb' };

function readPersistedTheme() {
  try {
    const raw = fs.readFileSync(THEME_FILE, 'utf8');
    const mode = JSON.parse(raw).mode;
    return mode === 'light' || mode === 'dark' ? mode : 'dark';
  } catch {
    return 'dark';
  }
}

function writePersistedTheme(mode) {
  try {
    fs.writeFileSync(THEME_FILE, JSON.stringify({ mode }), 'utf8');
  } catch {
    /* best effort; a missing persisted theme just falls back to dark. */
  }
}
const STARTUP_TIMEOUT_MS = Number(process.env.CW_STARTUP_TIMEOUT_MS || 30000);
// Leave room after the backend's 5s drain budget for persistence and transport
// closure. Timing out retains ownership; it never escalates to killing the root.
const BACKEND_STOP_TIMEOUT_MS = 10000;

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null;
/** @type {{ host: string, port: number, basePath: string } | null} */
let backendControl = null;
/** @type {Promise<boolean> | null} */
let stoppingBackend = null;
let backendGeneration = 0;
let shutdownAction = null;
let backendOwner = null;

// On Windows, when the app shuts down the stdout/stderr pipe can close before
// the backend's exit/log handlers run; a raw write then throws EPIPE, which
// Electron surfaces as an "Uncaught Exception" dialog in the main process.
// Swallow those stream errors and guard every write so shutdown stays clean.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

/** Writes to a std stream, ignoring broken-pipe errors during shutdown. */
function safeWrite(stream, text) {
  try {
    stream.write(text);
  } catch {
    /* pipe already closed (EPIPE) — nothing to log to */
  }
}

/** Finds a free TCP port by binding to port 0 and reading the assigned port. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves once the backend answers on /api/providers, or rejects on timeout. */
function waitForBackend(port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const url = `http://${HOST}:${port}/api/providers`;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error('Backend did not start in time'));
        return;
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

/** Spawns the backend as a Node process. Electron's bundled Node lacks the
 * experimental `node:sqlite` builtin, so we use the system Node (>=22.5). */
function startBackend(port) {
  if (backend || shutdownAction || !isBackendShutdownConfirmed()) {
    throw new Error('The previous backend is still owned or shutdown is in progress.');
  }
  const userData = app.getPath('userData');
  const nodeBin = process.env.CW_NODE_BIN || 'node';
  const apiBasePath = process.env.CW__api__basePath || '/api';
  const shutdownNonce = randomUUID();
  const env = {
    ...process.env,
    CW__api__port: String(port),
    CW__api__host: HOST,
    CW__api__basePath: apiBasePath,
    CW__persistence__databasePath: path.join(userData, 'workspace.db'),
    CW__session__usageDir: path.join(userData, 'usage'),
    CW_UI_DIST: UI_DIST,
    CW_LOG_LEVEL: process.env.CW_LOG_LEVEL || 'info',
    CW_DESKTOP_SHUTDOWN_NONCE: shutdownNonce,
  };
  backendControl = { host: HOST, port, basePath: apiBasePath };
  const child = spawn(nodeBin, [BACKEND_ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  ownBackend(child, shutdownNonce);
}

function isBackendShutdownConfirmed() {
  return backendOwner === null || (backendOwner.acknowledged &&
    backendOwner.outcome?.code === 0 && backendOwner.outcome.signal == null);
}

function ownBackend(child, nonce) {
  backend = child;
  backendGeneration += 1;
  const owner = { child, nonce, acknowledged: false, outcome: null };
  backendOwner = owner;
  child.on('message', (message) => {
    if (message?.type === 'shutdown-complete' && message.nonce === nonce) {
      owner.acknowledged = true;
    }
  });
  child.stdout.on('data', (chunk) => safeWrite(process.stdout, `[backend] ${chunk}`));
  child.stderr.on('data', (chunk) => safeWrite(process.stderr, `[backend] ${chunk}`));
  child.on('error', (error) =>
    safeWrite(process.stderr, `[backend] spawn error: ${error}\n`),
  );
  child.on('exit', (code, signal) => {
    owner.outcome = { code, signal };
    safeWrite(process.stdout, `[backend] exited with code ${code}\n`);
    if (backend === child) {
      backend = null;
      backendControl = null;
    }
  });
}

async function stopBackend() {
  if (!backend) {
    return isBackendShutdownConfirmed();
  }
  if (stoppingBackend) {
    return stoppingBackend;
  }
  const child = backend;
  const owner = backendOwner;
  const control = backendControl;
  const task = (async () => {
    // IPC remains available after transport closure, allowing a deliberate
    // retry of later cleanup phases. The root coalesces both request paths.
    await Promise.all([
      requestBackendShutdownIpc(child, owner.nonce),
      control ? requestBackendShutdown(control) : Promise.resolve(false),
    ]);
    // Killing the root process cannot confirm cleanup of its owned work.
    const exited = await waitForChildExit(child, BACKEND_STOP_TIMEOUT_MS);
    const confirmed = exited && owner.acknowledged &&
      owner.outcome?.code === 0 && owner.outcome.signal == null;
    if (confirmed && backend === child) {
      backend = null;
      backendControl = null;
    }
    return confirmed;
  })();
  stoppingBackend = task;
  try {
    return await task;
  } finally {
    if (stoppingBackend === task) {
      stoppingBackend = null;
    }
  }
}

function reportShutdownFailure(action) {
  const message = backendOwner?.outcome && !isBackendShutdownConfirmed()
    ? `Cannot ${action}: the backend exited without confirmed cooperative cleanup. No replacement or installer was started. Keep this window open and check diagnostics before recovering the backend.`
    : `Cannot ${action}: backend shutdown was not confirmed. The app has not quit or started a replacement. Wait for active work to finish, then try again.`;
  safeWrite(process.stderr, `[desktop] ${message}\n`);
  dialog.showErrorBox('Shutdown not confirmed', message);
}

function runAfterBackendStop(action, proceed, terminal = true) {
  if (shutdownAction) {
    if (shutdownAction.action === action) {
      return shutdownAction.promise;
    }
    reportShutdownFailure(action);
    return Promise.resolve(false);
  }
  const generation = backendGeneration;
  const attempt = { action, generation, confirmed: false, promise: null };
  shutdownAction = attempt;
  attempt.promise = (async () => {
    try {
      if (await stopBackend() !== true || !isBackendShutdownConfirmed() ||
          backend || backendGeneration !== generation) {
        reportShutdownFailure(action);
        return false;
      }
      attempt.confirmed = true;
      proceed();
      return true;
    } catch {
      attempt.confirmed = false;
      reportShutdownFailure(action);
      return false;
    } finally {
      // Retain successful terminal-action ownership until the actual quit is
      // admitted; a completed promise alone must not permit a replacement.
      if (shutdownAction === attempt && (!attempt.confirmed || !terminal)) {
        shutdownAction = null;
      }
    }
  })();
  return attempt.promise;
}

/** Origin (scheme://host:port) of the app's own page, used to gate IPC and navigation. */
let appOrigin = null;

/** Records the trusted app origin from the URL the window loads. */
function setAppOrigin(loadUrl) {
  try {
    appOrigin = new URL(loadUrl).origin;
  } catch {
    appOrigin = null;
  }
}

/**
 * True when an IPC message originates from our own top-level app frame. Guards
 * the main-process handlers so a compromised/injected subframe or unexpected
 * origin cannot drive privileged actions (reveal file, theme).
 */
function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || !appOrigin) {
    return false;
  }
  try {
    return new URL(frame.url).origin === appOrigin;
  } catch {
    return false;
  }
}

/**
 * Opens the product documentation that ships inside the app. Prefers the bundled
 * docs (staged into `resources/docs` at build time, README included), opening the
 * README first and falling back to the docs folder; if neither can be opened by
 * the OS it opens the online docs in the browser.
 */
async function openDocs() {
  const candidates = [
    path.join(DOCS_DIR, 'README.md'),
    path.join(ROOT, 'README.md'),
    DOCS_DIR,
  ];
  for (const target of candidates) {
    if (!fs.existsSync(target)) {
      continue;
    }
    const error = await shell.openPath(target);
    if (!error) {
      return;
    }
  }
  void shell.openExternal(DOCS_URL);
}

/** Shows the native About dialog with the app version and runtime details. */
function showAboutDialog(win) {
  const icon = appIcon();
  void dialog.showMessageBox(win ?? undefined, {
    type: 'info',
    ...(icon ? { icon } : {}),
    title: 'About AI Project Studio',
    message: 'AI Project Studio',
    detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nNode ${process.versions.node}\nChromium ${process.versions.chrome}`,
    buttons: ['OK', 'Documentation'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }).then((result) => {
    if (result.response === 1) {
      void openDocs();
    }
  });
}

/**
 * Copy/paste shortcuts belong to the renderer/browser, not a second registered
 * menu accelerator. Menu clicks still dispatch the native editing event. The
 * terminal's capture listeners own those events; cut remains Chromium-owned.
 */
function installApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const editSubmenu = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    {
      label: 'Copy',
      accelerator: 'CmdOrCtrl+C',
      registerAccelerator: false,
      click: (_item, win) => win?.webContents.copy(),
    },
    // Paste without a registered accelerator — see the doc comment above.
    {
      label: 'Paste',
      accelerator: 'CmdOrCtrl+V',
      registerAccelerator: false,
      click: (_item, win) => win?.webContents.paste(),
    },
    {
      label: 'Paste and Match Style',
      accelerator: 'CmdOrCtrl+Shift+V',
      registerAccelerator: false,
      click: (_item, win) => win?.webContents.pasteAndMatchStyle(),
    },
    { role: 'delete' },
    { role: 'selectAll' },
  ];
  const helpSubmenu = [
    {
      label: 'Documentation',
      accelerator: 'F1',
      click: () => void openDocs(),
    },
    { type: 'separator' },
    {
      label: 'Check for Updates…',
      click: () => void updateManager.checkForUpdates(true),
    },
    ...(isMac
      ? []
      : [
          { type: 'separator' },
          {
            label: 'About AI Project Studio',
            click: (_item, win) => showAboutDialog(win),
          },
        ]),
  ];
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { label: 'Edit', submenu: editSubmenu },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: helpSubmenu },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(loadUrl) {
  lastWindowUrl = loadUrl;
  installApplicationMenu();
  const launchTheme = readPersistedTheme();
  const icon = appIcon();
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: THEME_BG[launchTheme],
    title: 'AI Project Studio',
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Open external links in the system browser, keep app links in-window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ipcInput.isExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block any in-page navigation away from the app's own origin. Legitimate
  // external links go through the window-open handler above; anything else
  // (e.g. an injected redirect) is denied and sent to the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    let sameOrigin = false;
    try {
      sameOrigin = appOrigin !== null && new URL(url).origin === appOrigin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      event.preventDefault();
      if (ipcInput.isExternalUrl(url)) {
        void shell.openExternal(url);
      }
    }
  });

  // If the very first load hits a transient failure (backend not fully serving
  // yet, a navigation blip, etc.) the window would otherwise stay blank forever
  // because nothing reloads it. Retry the load a few times with a short backoff
  // so the window recovers on its own instead of showing a blank page.
  const MAX_LOAD_RETRIES = 20;
  let loadRetries = 0;
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 (ERR_ABORTED) fires for benign in-page navigations; ignore it. Only
    // retry main-frame failures for our own app URL.
    if (!isMainFrame || errorCode === -3) {
      return;
    }
    if (loadRetries >= MAX_LOAD_RETRIES || win.isDestroyed()) {
      safeWrite(
        process.stderr,
        `[desktop] Giving up loading ${loadUrl} after ${loadRetries} retries: ${errorCode} ${errorDescription}\n`,
      );
      return;
    }
    loadRetries += 1;
    safeWrite(
      process.stderr,
      `[desktop] Load failed (${errorCode} ${errorDescription}); retry ${loadRetries}/${MAX_LOAD_RETRIES}\n`,
    );
    setTimeout(() => {
      if (!win.isDestroyed()) {
        void win.loadURL(loadUrl);
      }
    }, 300);
  });

  void win.loadURL(loadUrl);
  mainWindow = win;
  win.on('close', (event) => {
    if (BrowserWindow.getAllWindows().length > 1 || isBackendShutdownConfirmed()) {
      return;
    }
    event.preventDefault();
    if (shutdownAction) {
      return;
    }
    if (process.platform === 'darwin') {
      void runAfterBackendStop('close window', () => win.close(), false);
    } else {
      app.quit();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  return win;
}

/**
 * Applies a Content-Security-Policy to every document the app loads. Restricts
 * scripts/connections/frames to the app's own origin so injected content cannot
 * pull in remote code or exfiltrate over the network. Skipped in dev, where the
 * Vite HMR client relies on eval and websocket origins CSP would block.
 */
function applyContentSecurityPolicy() {
  if (IS_DEV) {
    return;
  }
  const policy = [
    "default-src 'self'",
    // Bundled app scripts are same-origin; 'unsafe-inline' covers Vite's tiny
    // inline module-preload polyfill while still blocking remote scripts.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // Same-origin API + terminal WebSocket only.
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

async function bootstrap() {
  // Group windows under our own taskbar identity (and pick up the packaged icon)
  // on Windows instead of the generic electron.exe entry.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.sourabh1007.aiprojectstudio');
  }
  // Native chrome (title bar + menu bar) follows the app theme. Seed from the
  // persisted value so the launch chrome matches the window background; the
  // renderer syncs the authoritative value once it mounts.
  nativeTheme.themeSource = readPersistedTheme();
  ipcMain.on('theme:set', (event, mode) => {
    if (!isTrustedSender(event)) {
      return;
    }
    if (ipcInput.isThemeMode(mode)) {
      nativeTheme.themeSource = mode;
      writePersistedTheme(mode);
    }
  });

  // Reveal a session-created file in the OS file explorer. Guarded to a safe
  // absolute path so a malformed or relative message can't crash the main
  // process or resolve against an unexpected working directory.
  ipcMain.on('file:reveal', (event, filePath) => {
    if (!isTrustedSender(event)) {
      return;
    }
    if (ipcInput.isRevealablePath(filePath)) {
      shell.showItemInFolder(filePath);
    }
  });

  // Open an external link (e.g. the GitHub device-flow verification page) in
  // the user's default browser. Restricted to web/mail protocols so the
  // renderer can't ask the OS to launch arbitrary protocols.
  ipcMain.on('link:open', (event, url) => {
    if (!isTrustedSender(event)) {
      return;
    }
    if (ipcInput.isExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.handle('app:relaunch', (event) => {
    if (!isTrustedSender(event)) {
      return false;
    }
    return runAfterBackendStop('relaunch', () => {
      app.relaunch();
      app.exit(0);
    });
  });

  // Exposes the packaged app version to the renderer's About section.
  ipcMain.handle('app:getVersion', (event) => {
    if (!isTrustedSender(event)) {
      return '';
    }
    return app.getVersion();
  });

  // Auto-update IPC. All guarded to our own frame; the update manager itself is
  // defensive so a rejected/failed update never surfaces as an exception here.
  ipcMain.handle('update:getState', (event) => {
    if (!isTrustedSender(event)) {
      return null;
    }
    return updateManager.getState();
  });
  ipcMain.handle('update:check', (event) => {
    if (!isTrustedSender(event)) {
      return null;
    }
    return updateManager.checkForUpdates(true);
  });
  ipcMain.handle('update:download', (event) => {
    if (!isTrustedSender(event)) {
      return null;
    }
    return updateManager.downloadUpdate();
  });
  ipcMain.handle('update:install', (event) => {
    if (!isTrustedSender(event)) {
      return null;
    }
    return updateManager.installNow();
  });

  // Opens the documentation that ships with the app (same as Help ▸ Documentation).
  ipcMain.on('app:openDocs', (event) => {
    if (!isTrustedSender(event)) {
      return;
    }
    void openDocs();
  });

  // Native clipboard bridge. The renderer's async `navigator.clipboard` API is
  // unreliable under Electron's sandbox (writes silently reject when the
  // document isn't considered focused), so terminal copy/paste is routed
  // through the main process's native clipboard module instead.
  require('./clipboard.cjs').registerClipboardIpc(ipcMain, clipboard, isTrustedSender);
  if (regression) {
    ipcMain.handle('clipboard:smoke', (event) => {
      if (!isTrustedSender(event)) return { status: 'unsupported' };
      return require('./regression-clipboard.cjs').runClipboardSmoke(clipboard,
        (expression) => event.sender.executeJavaScript(expression));
    });
  }

  ipcMain.handle('clipboard:read', (event) => {
    if (!isTrustedSender(event)) {
      return '';
    }
    return clipboard.readText();
  });

  const getAttachmentStore = () => {
    const { createOwnedAttachmentStore } = require('./owned-attachments.cjs');
    clipboardAttachmentStore ??= createOwnedAttachmentStore({
      root: path.join(app.getPath('userData'), 'clipboard-attachments'),
    });
    return clipboardAttachmentStore;
  };
  // Return structured paths; only app-created images acquire an owned lease.
  ipcMain.handle('clipboard:readImage', (event, request) => {
    if (!isTrustedSender(event)) {
      return { status: 'error', error: 'untrusted' };
    }
    const { readClipboardAttachment } = require('./owned-attachments.cjs');
    return readClipboardAttachment({
      clipboard, store: getAttachmentStore(), sessionId: request?.sessionId,
    });
  });
  require('./owned-attachments.cjs').registerAttachmentManagementIpc({
    ipcMain, isTrustedSender, getStore: getAttachmentStore,
    confirmRemoval: async ({ count }) => {
      const result = await dialog.showMessageBox({
        type: 'warning', buttons: ['Cancel', 'Delete images'], defaultId: 0, cancelId: 0,
        noLink: true, title: 'Delete retained clipboard images',
        message: `Permanently delete ${count} selected clipboard image${count === 1 ? '' : 's'}?`,
        detail: 'This cannot be undone. Active, previous, or resumed prompts may still reference these images and may stop working. No provider-history safety check is available.',
        checkboxLabel: 'I understand that deleting these images may break prompts that reference them.',
        checkboxChecked: false,
      });
      return result.response === 1 && result.checkboxChecked === true;
    },
  });

  applyContentSecurityPolicy();

  let loadUrl;
  if (IS_DEV) {
    loadUrl = DEV_URL;
  } else {
    if (!fs.existsSync(BACKEND_ENTRY)) {
      throw new Error(
        `Backend build not found at ${BACKEND_ENTRY}. Run "npm run build" first.`,
      );
    }
    const port = await getFreePort();
    startBackend(port);
    await waitForBackend(port);
    loadUrl = `http://${HOST}:${port}/`;
  }
  setAppOrigin(loadUrl);
  createWindow(loadUrl);

  // Updates use a guided release-page flow; no installer is launched on quit.
  updateManager.init({
    getWindow: () => mainWindow,
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0] ||
      (lastWindowUrl && !isBackendShutdownConfirmed() ? createWindow(lastWindowUrl) : null);
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((error) => {
    safeWrite(process.stderr, `[desktop] Startup failed: ${error}\n`);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (lastWindowUrl && !isBackendShutdownConfirmed()) {
        createWindow(lastWindowUrl);
      } else {
        void bootstrap().catch(() => reportShutdownFailure('start a replacement backend'));
      }
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
      return;
    }
    void runAfterBackendStop('stop backend', () => {}, false);
  });

  app.on('before-quit', (event) => {
    if (isBackendShutdownConfirmed() && shutdownAction?.confirmed && shutdownAction.generation === backendGeneration) {
      shutdownAction = null;
      return;
    }
    if (isBackendShutdownConfirmed() && !shutdownAction) {
      return;
    }
    event.preventDefault();
    if (shutdownAction) {
      return;
    }
    void runAfterBackendStop('quit', () => app.quit());
  });
}
