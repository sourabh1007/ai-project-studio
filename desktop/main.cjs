'use strict';

const { app, BrowserWindow, shell, nativeTheme, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, '..');
const BACKEND_ENTRY = path.join(ROOT, 'backend', 'dist', 'main.js');
const UI_DIST = path.join(ROOT, 'ui', 'dist');
const HOST = '127.0.0.1';
const IS_DEV = process.env.CW_DESKTOP_DEV === '1';
const DEV_URL = process.env.CW_DEV_URL || 'http://localhost:5173';
const STARTUP_TIMEOUT_MS = Number(process.env.CW_STARTUP_TIMEOUT_MS || 30000);

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null;

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
  backend.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  backend.stderr.on('data', (chunk) => process.stderr.write(`[backend] ${chunk}`));
  backend.on('error', (error) =>
    process.stderr.write(`[backend] spawn error: ${error}\n`),
  );
  backend.on('exit', (code) => {
    process.stdout.write(`[backend] exited with code ${code}\n`);
    backend = null;
  });
}

function stopBackend() {
  if (backend && !backend.killed) {
    backend.kill();
    backend = null;
  }
}

function createWindow(loadUrl) {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1020',
    title: 'Copilot Workspace',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Open external links in the system browser, keep app links in-window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(loadUrl);
  return win;
}

async function bootstrap() {
  // Native chrome (title bar + menu bar) follows the app theme. Default to dark
  // so it matches the dark launch background; the renderer syncs the real value.
  nativeTheme.themeSource = 'dark';
  ipcMain.on('theme:set', (_event, mode) => {
    if (mode === 'light' || mode === 'dark') {
      nativeTheme.themeSource = mode;
    }
  });

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
    process.stderr.write(`[desktop] Startup failed: ${error}\n`);
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
