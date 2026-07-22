'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, safe bridge exposed to the renderer. Lets the web UI tell the main
 * process which theme is active so the native window chrome (title bar and
 * menu bar) can match instead of staying light in dark mode.
 */
contextBridge.exposeInMainWorld('desktop', {
  setTheme(mode) {
    if (mode === 'light' || mode === 'dark') {
      ipcRenderer.send('theme:set', mode);
    }
  },
});
