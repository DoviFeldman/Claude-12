const { app, BrowserWindow, ipcMain, shell, protocol, nativeImage, Menu } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

let win = null;
let dirWatcher = null;

// --smoke-test: boot the app, wait for the renderer to report it finished
// initializing, print all renderer console output, and exit 0/1. Used by CI
// on the macOS runner to prove the packaged app actually runs.
const SMOKE_TEST = process.argv.includes('--smoke-test');

// ---------------------------------------------------------------------------
// qlfile:// protocol — serves local files to the renderer (images, video,
// audio, PDF) with streaming support so <video> can seek.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'qlfile', privileges: { supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

function qlfileToPath(url) {
  return decodeURIComponent(url.replace(/^qlfile:\/\//, ''));
}

// ---------------------------------------------------------------------------
// Preferences (favorites, view options) persisted in userData
// ---------------------------------------------------------------------------
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
let prefs = null;

function loadPrefs() {
  if (prefs) return prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
  } catch {
    prefs = {};
  }
  if (!Array.isArray(prefs.favorites)) prefs.favorites = [];
  return prefs;
}

function savePrefs() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch (e) {
    console.error('savePrefs failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------
async function statEntry(dir, name) {
  const full = path.join(dir, name);
  let st;
  try {
    st = await fsp.stat(full);
  } catch {
    try { st = await fsp.lstat(full); } catch { return null; }
  }
  const isDir = st.isDirectory();
  const ext = isDir ? '' : path.extname(name).slice(1).toLowerCase();
  // "Date created / downloaded": birthtime on macOS. Some filesystems report a
  // bogus 0/epoch birthtime — fall back to mtime in that case.
  let born = st.birthtimeMs;
  if (!born || born < 86400000) born = st.mtimeMs;
  return {
    name,
    path: full,
    isDir,
    size: isDir ? -1 : st.size,
    ext,
    birthtime: born,
    mtime: st.mtimeMs,
    hidden: name.startsWith('.')
  };
}

ipcMain.handle('list-dir', async (e, dir) => {
  try {
    const names = await fsp.readdir(dir);
    const out = [];
    const BATCH = 64;
    for (let i = 0; i < names.length; i += BATCH) {
      const chunk = await Promise.all(names.slice(i, i + BATCH).map(n => statEntry(dir, n)));
      for (const c of chunk) if (c) out.push(c);
    }
    return { dir, entries: out };
  } catch (err) {
    return { dir, error: err.message, entries: [] };
  }
});

// ---------------------------------------------------------------------------
// Thumbnails — generated on demand (renderer only asks for visible tiles).
// On macOS nativeImage.createThumbnailFromPath uses Quick Look, which gives us
// previews for images, videos, PDFs and anything with a QL plugin.
// ---------------------------------------------------------------------------
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif', 'avif', 'jfif', 'svg']);
const thumbCache = new Map(); // key -> dataURL
const iconCache = new Map();  // ext/kind -> dataURL
const THUMB_CACHE_MAX = 2500;

function cachePut(map, key, val, max) {
  if (map.size >= max) {
    const first = map.keys().next().value;
    map.delete(first);
  }
  map.set(key, val);
}

async function fileIconDataUrl(p, ext, isDir) {
  const key = isDir ? '<dir>' : (ext || '<none>');
  if (iconCache.has(key)) return iconCache.get(key);
  try {
    const icon = await app.getFileIcon(p, { size: 'large' });
    if (!icon.isEmpty()) {
      const url = icon.toDataURL();
      cachePut(iconCache, key, url, 300);
      return url;
    }
  } catch { /* ignore */ }
  return null;
}

ipcMain.handle('get-thumb', async (e, p, size, mtime) => {
  const key = `${p}|${mtime}|${size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);

  const ext = path.extname(p).slice(1).toLowerCase();
  let isDir = false;
  try { isDir = (await fsp.stat(p)).isDirectory(); } catch { /* gone */ }

  const result = { thumb: null, dims: null, icon: false };

  if (!isDir) {
    // 1) System thumbnailer (Quick Look on macOS)
    try {
      const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
      if (img && !img.isEmpty()) result.thumb = img.toDataURL();
    } catch { /* not supported on this platform / file type */ }

    // 2) Fallback for plain images
    if (!result.thumb && IMAGE_EXTS.has(ext) && ext !== 'svg') {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          const s = img.getSize();
          result.dims = { w: s.width, h: s.height };
          const scaled = s.width > s.height ? img.resize({ width: size }) : img.resize({ height: size });
          result.thumb = scaled.toDataURL();
        }
      } catch { /* ignore */ }
    }
  }

  if (IMAGE_EXTS.has(ext) && !result.dims) {
    result.dims = await imageDims(p).catch(() => null);
  }

  // 3) Generic system file icon
  if (!result.thumb) {
    result.thumb = await fileIconDataUrl(p, ext, isDir);
    result.icon = true;
  }

  cachePut(thumbCache, key, result, THUMB_CACHE_MAX);
  return result;
});

// ---------------------------------------------------------------------------
// Image dimension probing (reads only file headers, cheap)
// ---------------------------------------------------------------------------
async function imageDims(p) {
  const st = await fsp.stat(p);
  const len = Math.min(st.size, 2 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  const fh = await fsp.open(p, 'r');
  try { await fh.read(buf, 0, len, 0); } finally { await fh.close(); }

  // PNG
  if (len > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF
  if (len > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // BMP
  if (len > 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }
  // WEBP
  if (len > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X') {
      return {
        w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      };
    }
  }
  // JPEG — scan markers for SOF
  if (len > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < len) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

ipcMain.handle('get-dims', (e, p) => imageDims(p).catch(() => null));

// ---------------------------------------------------------------------------
// File contents for Quick Look
// ---------------------------------------------------------------------------
ipcMain.handle('read-text', async (e, p, maxBytes = 256 * 1024) => {
  try {
    const st = await fsp.stat(p);
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fh = await fsp.open(p, 'r');
    try { await fh.read(buf, 0, len, 0); } finally { await fh.close(); }
    return { text: buf.toString('utf8'), truncated: st.size > maxBytes };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('read-file', async (e, p, maxBytes = 300 * 1024 * 1024) => {
  try {
    const st = await fsp.stat(p);
    if (st.size > maxBytes) return { error: 'File too large to preview' };
    const buf = await fsp.readFile(p);
    return { data: buf };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------
ipcMain.handle('open-path', (e, p) => shell.openPath(p));

ipcMain.handle('trash', async (e, paths) => {
  const errors = [];
  for (const p of paths) {
    try { await shell.trashItem(p); }
    catch (err) { errors.push(`${path.basename(p)}: ${err.message}`); }
  }
  return { errors };
});

ipcMain.handle('rename', async (e, p, newName) => {
  if (!newName || /[/\\]/.test(newName)) return { error: 'Invalid name' };
  const dest = path.join(path.dirname(p), newName);
  if (dest === p) return { path: p };
  try {
    if (fs.existsSync(dest)) return { error: `"${newName}" already exists` };
    await fsp.rename(p, dest);
    return { path: dest };
  } catch (err) {
    return { error: err.message };
  }
});

async function uniqueDest(destDir, name) {
  let dest = path.join(destDir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    dest = path.join(destDir, `${base} ${i}${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  throw new Error('Too many name collisions');
}

ipcMain.handle('move', async (e, paths, destDir) => {
  const errors = [];
  let moved = 0;
  for (const src of paths) {
    try {
      if (path.dirname(src) === destDir) continue;
      if (destDir === src || destDir.startsWith(src + path.sep)) {
        errors.push(`Can't move "${path.basename(src)}" into itself`);
        continue;
      }
      const dest = await uniqueDest(destDir, path.basename(src));
      try {
        await fsp.rename(src, dest);
      } catch (err) {
        if (err.code === 'EXDEV') {
          // Across volumes: copy then remove, like Finder does
          await fsp.cp(src, dest, { recursive: true, errorOnExist: true });
          await fsp.rm(src, { recursive: true });
        } else {
          throw err;
        }
      }
      moved++;
    } catch (err) {
      errors.push(`${path.basename(src)}: ${err.message}`);
    }
  }
  return { moved, errors };
});

ipcMain.handle('new-folder', async (e, dir) => {
  try {
    const dest = await uniqueDest(dir, 'untitled folder');
    await fsp.mkdir(dest);
    return { path: dest };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Sidebar places + prefs
// ---------------------------------------------------------------------------
ipcMain.handle('default-places', () => {
  const home = os.homedir();
  const places = [
    { name: 'Home', path: home, kind: 'home' },
    { name: 'Desktop', path: path.join(home, 'Desktop'), kind: 'desktop' },
    { name: 'Documents', path: path.join(home, 'Documents'), kind: 'documents' },
    { name: 'Downloads', path: path.join(home, 'Downloads'), kind: 'downloads' },
    { name: 'Pictures', path: path.join(home, 'Pictures'), kind: 'pictures' },
    { name: 'Movies', path: path.join(home, 'Movies'), kind: 'movies' },
    { name: 'Music', path: path.join(home, 'Music'), kind: 'music' }
  ];
  return places.filter(p => fs.existsSync(p.path));
});

ipcMain.handle('get-prefs', () => loadPrefs());
ipcMain.handle('set-prefs', (e, patch) => {
  loadPrefs();
  Object.assign(prefs, patch);
  savePrefs();
  return prefs;
});

// ---------------------------------------------------------------------------
// Live refresh when the current folder changes on disk
// ---------------------------------------------------------------------------
ipcMain.handle('watch-dir', (e, dir) => {
  if (dirWatcher) { try { dirWatcher.close(); } catch { /* ignore */ } dirWatcher = null; }
  if (!dir) return true;
  let timer = null;
  try {
    dirWatcher = fs.watch(dir, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('dir-changed', dir);
      }, 350);
    });
  } catch { /* dir may have vanished */ }
  return true;
});

// ---------------------------------------------------------------------------
// Native drag — lets files be dragged onto sidebar items, other folders,
// or straight out into the real Finder.
// ---------------------------------------------------------------------------
const FALLBACK_DRAG_ICON = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR4nGNgYGD4z0AhYBw1gGE0DBhGw4BhNAwYRsOAYTQMGEbDgIFCAAB2mgQrxrJ8VAAAAABJRU5ErkJggg=='
);

ipcMain.on('start-drag', async (e, paths) => {
  if (!paths || !paths.length) return;
  let icon = FALLBACK_DRAG_ICON;
  try {
    const fi = await app.getFileIcon(paths[0]);
    if (fi && !fi.isEmpty()) icon = fi;
  } catch { /* keep fallback */ }
  const opts = paths.length === 1 ? { file: paths[0], icon } : { files: paths, icon };
  e.sender.startDrag(opts);
});

ipcMain.handle('path-info', (e, p) => ({
  basename: path.basename(p) || p,
  dirname: path.dirname(p),
  isDir: (() => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })(),
  exists: fs.existsSync(p),
  home: os.homedir()
}));

// ---------------------------------------------------------------------------
// Window / app lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 460,
    title: 'Finder Viewer',
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    vibrancy: isMac ? 'sidebar' : undefined,
    backgroundColor: isMac ? undefined : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      spellcheck: false
    }
  });
  if (SMOKE_TEST) {
    const wc = win.webContents;
    wc.on('console-message', (e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
    });
    wc.on('did-fail-load', (e, code, desc, url) => {
      console.error(`[did-fail-load] ${code} ${desc} ${url}`);
    });
    wc.on('preload-error', (e, preloadPath, err) => {
      console.error(`[preload-error] ${preloadPath}: ${err}`);
    });
    wc.on('render-process-gone', (e, details) => {
      console.error(`[render-process-gone] ${JSON.stringify(details)}`);
    });
    const timer = setTimeout(() => {
      console.error('SMOKE FAIL: renderer did not finish init within 25s');
      app.exit(1);
    }, 25000);
    ipcMain.on('smoke-ok', () => {
      clearTimeout(timer);
      console.log('SMOKE OK: renderer initialized successfully');
      app.exit(0);
    });
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N', click: () => win && win.webContents.send('menu', 'new-folder') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Group by Day', accelerator: 'CmdOrCtrl+1', click: () => win && win.webContents.send('menu', 'group-day') },
        { label: 'Group by Month', accelerator: 'CmdOrCtrl+2', click: () => win && win.webContents.send('menu', 'group-month') },
        { type: 'separator' },
        { label: 'Grid View', accelerator: 'CmdOrCtrl+3', click: () => win && win.webContents.send('menu', 'view-grid') },
        { label: 'Feed View', accelerator: 'CmdOrCtrl+4', click: () => win && win.webContents.send('menu', 'view-feed') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('qlfile', (request, callback) => {
    try {
      callback({ path: qlfileToPath(request.url) });
    } catch {
      callback({ error: -6 }); // FILE_NOT_FOUND
    }
  });
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
