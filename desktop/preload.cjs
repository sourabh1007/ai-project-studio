'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function isExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return (
      protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
    );
  } catch {
    return false;
  }
}

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
    if (isExternalUrl(url)) {
      ipcRenderer.send('link:open', url);
    }
  },
  copyText(text) {
    return ipcRenderer.invoke('clipboard:write', text);
  },
  clearClipboard() {
    return ipcRenderer.invoke('clipboard:clear');
  },
  // No handler exists in ordinary launches; only the isolated regression shell.
  runClipboardSmoke() {
    return ipcRenderer.invoke('clipboard:smoke');
  },
  readText() {
    return ipcRenderer.invoke('clipboard:read');
  },
  /**
   * @param {{ sessionId: string }} request
   * @returns {Promise<import('../ui/src/lib/clipboard.js').ClipboardAttachmentResult>}
   */
  readImage(request) {
    return ipcRenderer.invoke('clipboard:readImage', request);
  },
  attachments: {
    list() {
      return ipcRenderer.invoke('attachments:list');
    },
    remove(request) {
      return ipcRenderer.invoke('attachments:remove', request);
    },
  },
  relaunch() {
    return ipcRenderer.invoke('app:relaunch');
  },
  /**
   * Subscribes to the notice that the backend stopped and could not be
   * restarted, so the UI can say so and offer a restart instead of leaving
   * every request to fail silently. Returns an unsubscribe function.
   */
  onBackendUnavailable(cb) {
    if (typeof cb !== 'function') {
      return () => {};
    }
    const onUnavailable = (_e, payload) => cb(payload);
    ipcRenderer.on('backend:unavailable', onUnavailable);
    return () => ipcRenderer.removeListener('backend:unavailable', onUnavailable);
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
