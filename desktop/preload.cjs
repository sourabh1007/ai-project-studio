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
  revealFile(filePath) {
    if (typeof filePath === 'string' && filePath.length > 0) {
      ipcRenderer.send('file:reveal', filePath);
    }
  },
  openExternal(url) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      ipcRenderer.send('link:open', url);
    }
  },
  copyText(text) {
    if (typeof text === 'string') {
      ipcRenderer.send('clipboard:write', text);
    }
  },
  readText() {
    return ipcRenderer.invoke('clipboard:read');
  },
  readImage() {
    return ipcRenderer.invoke('clipboard:readImage');
  },
  relaunch() {
    ipcRenderer.send('app:relaunch');
  },
  getVersion() {
    return ipcRenderer.invoke('app:getVersion');
  },
  openDocs() {
    ipcRenderer.send('app:openDocs');
  },
  updates: {
    getState() {
      return ipcRenderer.invoke('update:getState');
    },
    check() {
      return ipcRenderer.invoke('update:check');
    },
    download() {
      return ipcRenderer.invoke('update:download');
    },
    install() {
      return ipcRenderer.invoke('update:install');
    },
    /**
     * Subscribes to update state changes and the pre-install "flush your work"
     * signal. Returns an unsubscribe function. `cb` receives (type, payload)
     * where type is 'event' (state snapshot) or 'before-quit'.
     */
    onEvent(cb) {
      if (typeof cb !== 'function') {
        return () => {};
      }
      const onState = (_e, payload) => cb('event', payload);
      const onBeforeQuit = (_e, payload) => cb('before-quit', payload);
      ipcRenderer.on('update:event', onState);
      ipcRenderer.on('update:before-quit', onBeforeQuit);
      return () => {
        ipcRenderer.removeListener('update:event', onState);
        ipcRenderer.removeListener('update:before-quit', onBeforeQuit);
      };
    },
  },
});
