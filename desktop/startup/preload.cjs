'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('startup', {
  onState(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('startup:state', listener);
    return () => ipcRenderer.removeListener('startup:state', listener);
  },
  close() {
    ipcRenderer.send('startup:close');
  },
});
