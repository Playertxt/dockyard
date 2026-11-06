'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['tick', 'names', 'toast', 'event', 'focus', 'rules', 'recent', 'settings', 'navigate', 'paused']);

contextBridge.exposeInMainWorld('lookout', {
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error('unknown channel ' + channel);
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } }
});
