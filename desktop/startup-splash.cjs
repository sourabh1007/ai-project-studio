'use strict';

const path = require('node:path');

const STAGES = {
  preparing: { step: 0, title: 'Preparing your workspace', detail: 'Loading desktop settings and application preferences.' },
  starting: { step: 1, title: 'Starting local services', detail: 'Loading backend modules and preparing your workspace database.' },
  connecting: { step: 1, title: 'Connecting to your workspace', detail: 'Waiting for the local API and provider registry to respond.' },
  development: { step: 1, title: 'Connecting to development services', detail: 'Using the existing development server; no new backend is started.' },
  interface: { step: 2, title: 'Loading the interface', detail: 'Loading index.html, application scripts, styles, and workspace views.' },
  ready: { step: 3, title: 'Your workspace is ready', detail: 'Opening AI Project Studio.' },
  closing: { step: -1, title: 'Closing safely', detail: 'Waiting for background services to finish and save their work.' },
};

function createStartupSplash({ BrowserWindow, ipcMain, icon, theme, version, canClose, onClose }) {
  const window = new BrowserWindow({
    width: 760, height: 500, resizable: false, maximizable: false, fullscreenable: false,
    frame: false, show: false, center: true, title: 'Starting AI Project Studio',
    backgroundColor: theme === 'light' ? '#eef2fb' : '#0b1020',
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: 'startup',
      preload: path.join(__dirname, 'startup', 'preload.cjs'),
    },
  });
  let loaded = false;
  let disposed = false;
  let state = { ...STAGES.preparing, phase: 'preparing', theme, version, failed: false };
  const publish = () => {
    if (loaded && !disposed) window.webContents.send('startup:state', state);
  };
  const close = (event) => {
    if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) {
      onClose();
    }
  };
  ipcMain.on('startup:close', close);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!disposed && !canClose()) {
      event.preventDefault();
      onClose();
    }
  });
  window.on('closed', () => {
    disposed = true;
    ipcMain.removeListener('startup:close', close);
  });
  window.webContents.on('did-finish-load', () => {
    loaded = true;
    publish();
  });
  const shown = new Promise((resolve) => window.once('ready-to-show', () => {
    if (!disposed) window.show();
    resolve();
  }));
  const ready = Promise.all([window.loadFile(path.join(__dirname, 'startup', 'index.html'), { query: { theme } }), shown]);
  return {
    window,
    ready,
    update(phase) {
      if (!Object.hasOwn(STAGES, phase)) throw new Error(`Unknown startup phase: ${phase}`);
      state = { ...state, ...STAGES[phase], phase, failed: false };
      publish();
    },
    fail(error) {
      state = { ...state, title: 'We could not open your workspace',
        detail: String(error?.message ?? error).slice(0, 2000), failed: true };
      publish();
      if (loaded && !disposed) window.show();
      return loaded && !disposed;
    },
    complete(mainWindow) {
      if (disposed) return;
      state = { ...state, ...STAGES.ready, phase: 'ready' };
      publish();
      mainWindow.show();
      disposed = true;
      window.destroy();
    },
    isDestroyed: () => disposed,
  };
}

module.exports = { createStartupSplash, STAGES };
