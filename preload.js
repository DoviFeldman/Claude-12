const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  listDir: (dir) => ipcRenderer.invoke('list-dir', dir),
  getThumb: (p, size, mtime) => ipcRenderer.invoke('get-thumb', p, size, mtime),
  getDims: (p) => ipcRenderer.invoke('get-dims', p),
  readText: (p, maxBytes) => ipcRenderer.invoke('read-text', p, maxBytes),
  readFile: (p) => ipcRenderer.invoke('read-file', p),

  openPath: (p) => ipcRenderer.invoke('open-path', p),
  trash: (paths) => ipcRenderer.invoke('trash', paths),
  rename: (p, newName) => ipcRenderer.invoke('rename', p, newName),
  move: (paths, destDir) => ipcRenderer.invoke('move', paths, destDir),
  newFolder: (dir) => ipcRenderer.invoke('new-folder', dir),

  defaultPlaces: () => ipcRenderer.invoke('default-places'),
  getPrefs: () => ipcRenderer.invoke('get-prefs'),
  setPrefs: (patch) => ipcRenderer.invoke('set-prefs', patch),
  pathInfo: (p) => ipcRenderer.invoke('path-info', p),

  watchDir: (dir) => ipcRenderer.invoke('watch-dir', dir),
  onDirChanged: (cb) => ipcRenderer.on('dir-changed', (e, dir) => cb(dir)),
  onMenu: (cb) => ipcRenderer.on('menu', (e, cmd) => cb(cmd)),

  startDrag: (paths) => ipcRenderer.send('start-drag', paths),
  smokeOk: () => ipcRenderer.send('smoke-ok')
});
