'use strict';

const { app, BrowserWindow, Menu, shell, nativeTheme, ipcMain, session, clipboard, dialog } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, '..');
const BACKEND_ENTRY = path.join(ROOT, 'backend', 'dist', 'main.js');
const UI_DIST = path.join(ROOT, 'ui', 'dist');
const DOCS_DIR = path.join(ROOT, 'docs');
const DOCS_URL = 'https://github.com/sourabh1007/ai-project-studio/tree/main/docs';
const HOST = '127.0.0.1';
const IS_DEV = process.env.CW_DESKTOP_DEV === '1';
const DEV_URL = process.env.CW_DEV_URL || 'http://localhost:5173';
const STARTUP_TIMEOUT_MS = Number(process.env.CW_STARTUP_TIMEOUT_MS || 30000);

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null;

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

/** Wraps a filesystem path in double quotes when it contains whitespace. */
function quotePathIfNeeded(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

/**
 * Reads file path(s) placed on the clipboard by copying files in the OS file
 * manager, so pasting them into the terminal yields their paths like a native
 * shell. On Windows the `CF_HDROP` payload is exposed as the `FileNameW` format
 * (UTF-16LE, NUL-separated); other platforms fall back to a newline/URI list.
 */
function readClipboardFilePaths() {
  try {
    if (process.platform === 'win32' && clipboard.has('FileNameW')) {
      const raw = clipboard.readBuffer('FileNameW').toString('ucs2');
      return raw
        .split('\0')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    for (const format of ['text/uri-list', 'public.file-url']) {
      if (clipboard.has(format)) {
        return clipboard
          .read(format)
          .split(/\r?\n/)
          .map((s) => s.replace(/^file:\/\//i, '').trim())
          .filter((s) => s.length > 0 && !s.startsWith('#'));
      }
    }
  } catch {
    /* no file list on the clipboard */
  }
  return [];
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
  const userData = app.getPath('userData');
  const nodeBin = process.env.CW_NODE_BIN || 'node';
  const env = {
    ...process.env,
    CW__api__port: String(port),
    CW__api__host: HOST,
    CW__persistence__databasePath: path.join(userData, 'workspace.db'),
    CW__session__usageDir: path.join(userData, 'usage'),
    CW_UI_DIST: UI_DIST,
    CW_LOG_LEVEL: process.env.CW_LOG_LEVEL || 'info',
  };
  backend = spawn(nodeBin, [BACKEND_ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (chunk) => safeWrite(process.stdout, `[backend] ${chunk}`));
  backend.stderr.on('data', (chunk) => safeWrite(process.stderr, `[backend] ${chunk}`));
  backend.on('error', (error) =>
    safeWrite(process.stderr, `[backend] spawn error: ${error}\n`),
  );
  backend.on('exit', (code) => {
    safeWrite(process.stdout, `[backend] exited with code ${code}\n`);
    backend = null;
  });
}

function stopBackend() {
  if (backend && !backend.killed) {
    backend.kill();
    backend = null;
  }
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
  void dialog.showMessageBox(win ?? undefined, {
    type: 'info',
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
 * Installs the application menu. It mirrors Electron's default menu but with one
 * critical change: the Paste items keep their visible shortcut yet do NOT register
 * the `CmdOrCtrl+V` accelerator (`registerAccelerator: false`). The default menu's
 * registered Paste accelerator calls `webContents.paste()`, which inserts the
 * clipboard into the focused xterm textarea *in addition to* xterm's own `paste`
 * event handler — pasting everything twice in the terminal. Leaving the accelerator
 * unregistered lets Chromium handle Ctrl/Cmd+V natively (single paste in inputs)
 * and lets xterm's paste event be the sole terminal paste path (single paste there).
 */
function installApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const editSubmenu = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
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
  installApplicationMenu();
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1020',
    title: 'AI Project Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Open external links in the system browser, keep app links in-window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
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
      void shell.openExternal(url);
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
  // Native chrome (title bar + menu bar) follows the app theme. Default to dark
  // so it matches the dark launch background; the renderer syncs the real value.
  nativeTheme.themeSource = 'dark';
  ipcMain.on('theme:set', (event, mode) => {
    if (!isTrustedSender(event)) {
      return;
    }
    if (mode === 'light' || mode === 'dark') {
      nativeTheme.themeSource = mode;
    }
  });

  // Reveal a session-created file in the OS file explorer. Guarded to a non-empty
  // string so a malformed message can't crash the main process.
  ipcMain.on('file:reveal', (event, filePath) => {
    if (!isTrustedSender(event)) {
      return;
    }
    if (typeof filePath === 'string' && filePath.length > 0) {
      shell.showItemInFolder(filePath);
    }
  });

  // Open an external https link (e.g. the GitHub device-flow verification page)
  // in the user's default browser. Restricted to http/https so the renderer
  // can't ask the OS to launch arbitrary protocols.
  ipcMain.on('link:open', (event, url) => {
    if (!isTrustedSender(event)) {
      return;
    }
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.on('app:relaunch', (event) => {
    if (!isTrustedSender(event)) {
      return;
    }
    stopBackend();
    app.relaunch();
    app.exit(0);
  });

  // Exposes the packaged app version to the renderer's About section.
  ipcMain.handle('app:getVersion', (event) => {
    if (!isTrustedSender(event)) {
      return '';
    }
    return app.getVersion();
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
  ipcMain.on('clipboard:write', (event, text) => {
    if (!isTrustedSender(event)) {
      return;
    }
    if (typeof text === 'string' && text.length > 0) {
      clipboard.writeText(text);
    }
  });

  ipcMain.handle('clipboard:read', (event) => {
    if (!isTrustedSender(event)) {
      return '';
    }
    return clipboard.readText();
  });

  // Native image/file paste, so the embedded terminal matches a real shell and
  // the user never has to drop out to PowerShell to attach a screenshot. Returns
  // a shell-ready path string (empty when the clipboard holds no image/file):
  //  - Explorer file copy  -> the quoted source path(s), like a native terminal.
  //  - Raw bitmap (a screenshot) -> persisted to a temp PNG whose path is pasted,
  //    since a PTY can't ingest binary image data but the CLI can attach a file.
  ipcMain.handle('clipboard:readImage', (event) => {
    if (!isTrustedSender(event)) {
      return '';
    }
    const filePaths = readClipboardFilePaths();
    if (filePaths.length > 0) {
      return filePaths.map(quotePathIfNeeded).join(' ');
    }
    try {
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        const dir = path.join(os.tmpdir(), 'ai-project-studio', 'clipboard');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `clip-${Date.now()}.png`);
        fs.writeFileSync(file, image.toPNG());
        return quotePathIfNeeded(file);
      }
    } catch {
      /* clipboard held no readable image */
    }
    return '';
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
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((error) => {
    safeWrite(process.stderr, `[desktop] Startup failed: ${error}\n`);
    stopBackend();
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void bootstrap();
    }
  });

  app.on('window-all-closed', () => {
    stopBackend();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', stopBackend);
  process.on('exit', stopBackend);
}
