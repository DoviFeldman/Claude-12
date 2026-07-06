'use strict';
/* Finder Viewer — renderer */

// ---------------------------------------------------------------------------
// Loud, on-screen error reporting — a silent blank window is undebuggable
// ---------------------------------------------------------------------------
function showFatalError(msg) {
  console.error('FATAL: ' + msg);
  let box = document.getElementById('fatal-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fatal-error';
    box.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:99999;' +
      'max-width:80%;max-height:60%;overflow:auto;background:#c62828;color:#fff;padding:14px 18px;' +
      'border-radius:10px;font:12px/1.5 monospace;white-space:pre-wrap;user-select:text;cursor:text;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.4)';
    document.body.appendChild(box);
  }
  box.textContent += (box.textContent ? '\n\n' : 'Finder Viewer hit an error:\n\n') + msg;
}
window.addEventListener('error', (e) => {
  showFatalError((e.message || 'Script error') + (e.filename ? `\n  at ${e.filename}:${e.lineno}` : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showFatalError(r && r.stack ? r.stack : String(r));
});

const api = window.api;
if (!api) {
  showFatalError('window.api is missing — the preload script failed to load.');
  throw new Error('preload missing');
}
if (api.platform === 'darwin') document.body.classList.add('mac');

const $ = (s) => document.querySelector(s);
const contentEl = $('#content');
const sectionsEl = $('#sections');
const emptyEl = $('#empty-msg');
const statusEl = $('#status-text');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  cwd: null,
  home: '',
  entries: [],
  grouping: 'day',       // 'day' | 'month'
  view: 'grid',          // 'grid' | 'feed'
  expanded: new Set(),   // section keys currently "See All"-ed
  selection: new Set(),  // selected paths
  anchorIdx: -1,         // index into displayOrder of last-clicked tile
  history: [],
  histIdx: -1,
  places: [],
  favorites: [],
  renaming: false,
  displayOrder: []       // entries in visible DOM order
};

// ---------------------------------------------------------------------------
// File-kind helpers
// ---------------------------------------------------------------------------
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','tiff','tif','heic','heif','avif','jfif','svg']);
const VIDEO_EXTS = new Set(['mp4','mov','m4v','webm','mkv','avi','mpg','mpeg']);
const AUDIO_EXTS = new Set(['mp3','m4a','wav','aac','flac','ogg','aiff','aif']);
const MODEL_EXTS = new Set(['stl','3mf']);
const PDF_EXTS   = new Set(['pdf']);
const TEXT_EXTS  = new Set(['txt','md','markdown','rtf','log','csv','tsv','json','js','mjs','cjs','ts','tsx','jsx','html','htm','css','scss','xml','yml','yaml','toml','ini','cfg','conf','sh','zsh','bash','py','rb','go','rs','c','h','cpp','hpp','java','kt','swift','m','sql','php','pl','lua','bat','ps1','gcode','env','gitignore','plist']);

function kindOf(entry) {
  if (entry.isDir) return 'folder';
  const e = entry.ext;
  if (IMAGE_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (MODEL_EXTS.has(e)) return 'model';
  if (PDF_EXTS.has(e)) return 'pdf';
  if (TEXT_EXTS.has(e) || e === '') return 'text';
  return 'other';
}

const PH_EMOJI = { folder:'📁', image:'🖼', video:'🎬', audio:'🎵', model:'🧊', pdf:'📕', text:'📄', other:'📄' };

function fmtSize(bytes) {
  if (bytes < 0) return 'Folder';
  if (bytes === 0) return 'Zero bytes';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function qlfileUrl(p) { return 'qlfile://' + encodeURIComponent(p); }

// ---------------------------------------------------------------------------
// Date grouping
// ---------------------------------------------------------------------------
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function monthLabel(t) {
  return new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Thumbnail lazy loading — tiles are only filled in as they scroll into view
// ---------------------------------------------------------------------------
const dimsCache = new Map();   // path|mtime -> {w,h}
const thumbMemo = new Map();   // path|mtime|size -> result
const THUMB_MEMO_MAX = 700;

let observer = null;
const thumbQueue = [];
let thumbActive = 0;
const THUMB_CONCURRENCY = 6;

function resetObserver() {
  if (observer) observer.disconnect();
  thumbQueue.length = 0;
  observer = new IntersectionObserver((recs) => {
    for (const rec of recs) {
      if (!rec.isIntersecting) continue;
      observer.unobserve(rec.target);
      thumbQueue.push(rec.target);
    }
    pumpThumbs();
  }, { root: contentEl, rootMargin: '400px 0px' });
}

function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const tile = thumbQueue.shift();
    if (!tile.isConnected) continue;
    thumbActive++;
    loadThumb(tile).finally(() => { thumbActive--; pumpThumbs(); });
  }
}

async function loadThumb(tile) {
  const entry = state.displayOrder[+tile.dataset.idx];
  if (!entry) return;
  const size = state.view === 'feed' ? 1024 : 256;
  const memoKey = `${entry.path}|${entry.mtime}|${size}`;
  let res = thumbMemo.get(memoKey);
  if (!res) {
    try { res = await api.getThumb(entry.path, size, entry.mtime); } catch { res = null; }
    if (res) {
      if (thumbMemo.size >= THUMB_MEMO_MAX) thumbMemo.delete(thumbMemo.keys().next().value);
      thumbMemo.set(memoKey, res);
    }
  }
  if (!res || !tile.isConnected) return;
  if (res.thumb) {
    const img = document.createElement('img');
    img.src = res.thumb;
    if (res.icon) img.classList.add('sysicon');
    const thumbDiv = tile.querySelector('.thumb');
    const ph = thumbDiv.querySelector('.ph');
    if (ph) thumbDiv.replaceChild(img, ph);
  }
  if (res.dims) {
    dimsCache.set(`${entry.path}|${entry.mtime}`, res.dims);
    const dimsEl = tile.querySelector('.fdims');
    if (dimsEl) dimsEl.textContent = `${res.dims.w} × ${res.dims.h}`;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function columnsPerRow() {
  const style = getComputedStyle(document.documentElement);
  const tileW = parseFloat(style.getPropertyValue('--tile-w')) || 148;
  const gap = parseFloat(style.getPropertyValue('--tile-gap')) || 10;
  const w = sectionsEl.clientWidth || contentEl.clientWidth;
  return Math.max(1, Math.floor((w + gap) / (tileW + gap)));
}

function groupEntries() {
  const byKey = new Map();
  const useDay = state.grouping === 'day';
  for (const en of state.entries) {
    const key = useDay ? dayKey(en.birthtime) : monthKey(en.birthtime);
    let g = byKey.get(key);
    if (!g) {
      g = { key, time: en.birthtime, items: [] };
      byKey.set(key, g);
    }
    g.items.push(en);
  }
  const groups = [...byKey.values()].sort((a, b) => b.key.localeCompare(a.key));
  for (const g of groups) {
    g.items.sort((a, b) => b.birthtime - a.birthtime);
    g.label = useDay ? dayLabel(g.time) : monthLabel(g.time);
  }
  return groups;
}

function makeTile(entry, idx) {
  const kind = kindOf(entry);
  const tile = document.createElement('div');
  tile.className = 'tile' + (entry.isDir ? ' folder' : '');
  tile.dataset.idx = idx;
  tile.dataset.path = entry.path;
  tile.draggable = true;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = PH_EMOJI[kind];
  thumb.appendChild(ph);

  const qlBtn = document.createElement('button');
  qlBtn.className = 'ql-btn';
  qlBtn.title = 'Quick Look (Space, or ⌥-click)';
  qlBtn.textContent = '👁';
  thumb.appendChild(qlBtn);
  tile.appendChild(thumb);

  const name = document.createElement('div');
  name.className = 'fname';
  name.textContent = entry.name;
  tile.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'fmeta';
  meta.textContent = fmtSize(entry.size);
  tile.appendChild(meta);

  const dims = document.createElement('div');
  dims.className = 'fmeta fdims';
  const cached = dimsCache.get(`${entry.path}|${entry.mtime}`);
  if (cached) dims.textContent = `${cached.w} × ${cached.h}`;
  else if (kind !== 'image') dims.style.display = 'none';
  tile.appendChild(dims);

  if (state.selection.has(entry.path)) tile.classList.add('selected');
  return tile;
}

function renderContent(keepScroll = false) {
  const prevScroll = contentEl.scrollTop;
  resetObserver();
  contentEl.classList.toggle('feed', state.view === 'feed');
  sectionsEl.textContent = '';
  state.displayOrder = [];

  const groups = groupEntries();
  emptyEl.style.display = groups.length ? 'none' : '';

  const cols = columnsPerRow();
  let idx = 0;

  for (const g of groups) {
    const section = document.createElement('div');
    section.className = 'section';
    section.dataset.key = g.key;

    const header = document.createElement('div');
    header.className = 'section-header';
    const label = document.createElement('span');
    label.className = 'sec-label';
    label.textContent = g.label;
    const sub = document.createElement('span');
    sub.className = 'sec-sub';
    sub.textContent = `${g.items.length} item${g.items.length === 1 ? '' : 's'}`;
    const spacer = document.createElement('span');
    spacer.className = 'sec-spacer';
    header.append(label, sub, spacer);

    const canCollapse = state.view === 'grid' && g.items.length > cols;
    const isExpanded = state.expanded.has(g.key);
    if (canCollapse) {
      const btn = document.createElement('button');
      btn.className = 'see-all';
      btn.textContent = isExpanded ? 'Show Less' : `See All (${g.items.length}) ›`;
      btn.addEventListener('click', () => {
        if (state.expanded.has(g.key)) state.expanded.delete(g.key);
        else state.expanded.add(g.key);
        renderContent(true);
      });
      header.appendChild(btn);
    }
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'grid';
    const visible = (canCollapse && !isExpanded) ? g.items.slice(0, cols) : g.items;
    for (const en of visible) {
      const tile = makeTile(en, idx);
      state.displayOrder.push(en);
      grid.appendChild(tile);
      observer.observe(tile);
      idx++;
    }
    section.appendChild(grid);
    sectionsEl.appendChild(section);
  }

  if (keepScroll) contentEl.scrollTop = prevScroll;
  updateStatus();
}

function updateSelectionClasses() {
  for (const tile of sectionsEl.querySelectorAll('.tile')) {
    tile.classList.toggle('selected', state.selection.has(tile.dataset.path));
  }
  updateStatus();
}

function updateStatus() {
  const n = state.entries.length;
  const s = state.selection.size;
  statusEl.textContent = s > 0
    ? `${s} of ${n} selected`
    : `${n} item${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
async function navigate(dir, { push = true } = {}) {
  if (push) {
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(dir);
    state.histIdx = state.history.length - 1;
  }
  state.cwd = dir;
  state.expanded.clear();
  state.selection.clear();
  state.anchorIdx = -1;
  await refresh(false);
  api.watchDir(dir);
  contentEl.scrollTop = 0;
  const info = await api.pathInfo(dir);
  $('#folder-title').textContent = info.basename;
  $('#btn-back').disabled = state.histIdx <= 0;
  $('#btn-forward').disabled = state.histIdx >= state.history.length - 1;
  renderSidebar();
}

async function refresh(keepScroll = true) {
  const res = await api.listDir(state.cwd);
  if (res.error) {
    state.entries = [];
    renderContent();
    emptyEl.style.display = '';
    emptyEl.textContent = `Can't read this folder: ${res.error}\n\nIf macOS asked for permission and it was denied, allow access in System Settings → Privacy & Security → Files & Folders.`;
    emptyEl.style.whiteSpace = 'pre-wrap';
    statusEl.textContent = res.error;
    return;
  }
  emptyEl.textContent = 'This folder is empty';
  state.entries = res.entries;
  // Drop selections for files that no longer exist
  const alive = new Set(state.entries.map(e => e.path));
  for (const p of [...state.selection]) if (!alive.has(p)) state.selection.delete(p);
  renderContent(keepScroll);
}

$('#btn-back').addEventListener('click', () => {
  if (state.histIdx > 0) { state.histIdx--; navigate(state.history[state.histIdx], { push: false }); }
});
$('#btn-forward').addEventListener('click', () => {
  if (state.histIdx < state.history.length - 1) { state.histIdx++; navigate(state.history[state.histIdx], { push: false }); }
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
const PLACE_ICONS = { home:'🏠', desktop:'🖥️', documents:'📑', downloads:'📥', pictures:'🌄', movies:'🎬', music:'🎵' };

function makeSbItem(item, removable) {
  const el = document.createElement('div');
  el.className = 'sb-item';
  el.dataset.path = item.path;
  el.dataset.isdir = item.isDir === false ? '0' : '1';
  if (item.path === state.cwd) el.classList.add('current');
  const icon = document.createElement('span');
  icon.className = 'sb-icon';
  icon.textContent = item.kind ? (PLACE_ICONS[item.kind] || '📁') : (item.isDir === false ? '📄' : '📁');
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = item.name;
  el.append(icon, label);

  el.addEventListener('click', () => {
    if (item.isDir === false) api.openPath(item.path);
    else navigate(item.path);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [{ label: 'Open', action: () => item.isDir === false ? api.openPath(item.path) : navigate(item.path) }];
    if (removable) {
      items.push('sep', { label: 'Remove from Sidebar', action: () => removeFavorite(item.path) });
    }
    showCtxMenu(e.clientX, e.clientY, items);
  });
  return el;
}

function renderSidebar() {
  const placesEl = $('#sb-places');
  placesEl.textContent = '';
  for (const p of state.places) placesEl.appendChild(makeSbItem(p, false));

  const favEl = $('#sb-favorites');
  favEl.textContent = '';
  $('#sb-fav-title').style.display = state.favorites.length ? '' : 'none';
  for (const f of state.favorites) favEl.appendChild(makeSbItem(f, true));
}

async function addFavorites(paths) {
  let changed = false;
  for (const p of paths) {
    if (state.favorites.some(f => f.path === p) || state.places.some(pl => pl.path === p)) continue;
    const info = await api.pathInfo(p);
    if (!info.exists) continue;
    state.favorites.push({ name: info.basename, path: p, isDir: info.isDir });
    changed = true;
  }
  if (changed) {
    await api.setPrefs({ favorites: state.favorites });
    renderSidebar();
  }
}

async function removeFavorite(p) {
  state.favorites = state.favorites.filter(f => f.path !== p);
  await api.setPrefs({ favorites: state.favorites });
  renderSidebar();
}

// ---------------------------------------------------------------------------
// Selection + clicks
// ---------------------------------------------------------------------------
function selectOnly(idx) {
  const en = state.displayOrder[idx];
  if (!en) return;
  state.selection = new Set([en.path]);
  state.anchorIdx = idx;
  updateSelectionClasses();
}

sectionsEl.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const idx = +tile.dataset.idx;

  if (e.target.closest('.ql-btn')) {
    selectOnly(idx);
    openQuickLook(idx);
    return;
  }
  if (state.renaming) return;

  if (e.altKey) {           // hold ⌥ and click → Quick Look
    selectOnly(idx);
    openQuickLook(idx);
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    const p = tile.dataset.path;
    if (state.selection.has(p)) state.selection.delete(p);
    else { state.selection.add(p); state.anchorIdx = idx; }
    updateSelectionClasses();
  } else if (e.shiftKey && state.anchorIdx >= 0) {
    const [a, b] = [Math.min(state.anchorIdx, idx), Math.max(state.anchorIdx, idx)];
    state.selection = new Set(state.displayOrder.slice(a, b + 1).map(en => en.path));
    updateSelectionClasses();
  } else {
    selectOnly(idx);
  }
});

sectionsEl.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || state.renaming) return;
  const en = state.displayOrder[+tile.dataset.idx];
  if (!en) return;
  if (en.isDir) navigate(en.path);
  else api.openPath(en.path);
});

contentEl.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.tile') && !state.renaming) {
    state.selection.clear();
    state.anchorIdx = -1;
    updateSelectionClasses();
  }
});

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
const ctxEl = $('#ctxmenu');

function showCtxMenu(x, y, items) {
  ctxEl.textContent = '';
  for (const it of items) {
    if (it === 'sep') {
      const s = document.createElement('div');
      s.className = 'sep';
      ctxEl.appendChild(s);
      continue;
    }
    const mi = document.createElement('div');
    mi.className = 'mi';
    mi.textContent = it.label;
    mi.addEventListener('click', () => { hideCtxMenu(); it.action(); });
    ctxEl.appendChild(mi);
  }
  ctxEl.style.display = 'block';
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function hideCtxMenu() { ctxEl.style.display = 'none'; }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) hideCtxMenu(); });
window.addEventListener('blur', hideCtxMenu);

contentEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const tile = e.target.closest('.tile');
  if (tile) {
    const idx = +tile.dataset.idx;
    const en = state.displayOrder[idx];
    if (!state.selection.has(en.path)) selectOnly(idx);
    const multi = state.selection.size > 1;
    const items = [
      { label: multi ? `Open ${state.selection.size} Items` : 'Open', action: () => openSelected() },
      { label: 'Quick Look', action: () => openQuickLook(idx) },
      'sep',
      { label: 'Rename', action: () => startRename(idx) },
      { label: multi ? `Move ${state.selection.size} Items to Trash` : 'Move to Trash', action: () => trashSelected() },
      'sep',
      { label: 'Add to Sidebar', action: () => addFavorites([...state.selection]) }
    ];
    showCtxMenu(e.clientX, e.clientY, items);
  } else {
    showCtxMenu(e.clientX, e.clientY, [
      { label: 'New Folder', action: () => newFolderHere() },
      'sep',
      { label: 'Refresh', action: () => refresh(true) }
    ]);
  }
});

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------
function openSelected() {
  for (const p of state.selection) {
    const en = state.entries.find(x => x.path === p);
    if (en && en.isDir && state.selection.size === 1) navigate(p);
    else api.openPath(p);
  }
}

async function trashSelected() {
  if (!state.selection.size) return;
  const res = await api.trash([...state.selection]);
  if (res.errors.length) statusEl.textContent = res.errors[0];
  state.selection.clear();
  state.anchorIdx = -1;
  await refresh(true);
}

async function newFolderHere() {
  const res = await api.newFolder(state.cwd);
  if (res.error) { statusEl.textContent = res.error; return; }
  await refresh(true);
  const idx = state.displayOrder.findIndex(en => en.path === res.path);
  if (idx >= 0) {
    selectOnly(idx);
    startRename(idx);
  }
}

function startRename(idx) {
  const en = state.displayOrder[idx];
  const tile = sectionsEl.querySelector(`.tile[data-idx="${idx}"]`);
  if (!en || !tile || state.renaming) return;
  state.renaming = true;
  const nameEl = tile.querySelector('.fname');
  nameEl.textContent = '';
  const input = document.createElement('input');
  input.value = en.name;
  nameEl.appendChild(input);
  input.focus();
  // Select the base name without the extension, like Finder
  const dot = en.isDir ? -1 : en.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : en.name.length);

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    state.renaming = false;
    const newName = input.value.trim();
    if (commit && newName && newName !== en.name) {
      const res = await api.rename(en.path, newName);
      if (res.error) {
        statusEl.textContent = res.error;
        await refresh(true);
      } else {
        state.selection = new Set([res.path]);
        await refresh(true);
      }
    } else {
      nameEl.textContent = en.name;
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------------------
// Drag & drop — native drags so files can go to sidebar, folders, or Finder
// ---------------------------------------------------------------------------
sectionsEl.addEventListener('dragstart', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  e.preventDefault();
  const p = tile.dataset.path;
  const paths = state.selection.has(p) ? [...state.selection] : [p];
  if (!state.selection.has(p)) selectOnly(+tile.dataset.idx);
  api.startDrag(paths);
});

function droppedPaths(e) {
  const out = [];
  for (const f of e.dataTransfer.files) if (f.path) out.push(f.path);
  return out;
}

let dropHighlight = null;
function setDropHighlight(el) {
  if (dropHighlight === el) return;
  if (dropHighlight) dropHighlight.classList.remove('droptarget');
  dropHighlight = el;
  if (el) el.classList.add('droptarget');
}

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const sbItem = e.target.closest('.sb-item');
  const folderTile = e.target.closest('.tile.folder');
  const sidebar = e.target.closest('#sidebar');
  if (sbItem && sbItem.dataset.isdir === '1') setDropHighlight(sbItem);
  else if (folderTile) setDropHighlight(folderTile);
  else if (sidebar) setDropHighlight($('#sb-drophint'));
  else setDropHighlight(null);
});

document.addEventListener('dragleave', (e) => {
  if (e.target === document.documentElement) setDropHighlight(null);
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const paths = droppedPaths(e);
  setDropHighlight(null);
  if (!paths.length) return;

  const sbItem = e.target.closest('.sb-item');
  const folderTile = e.target.closest('.tile.folder');
  const sidebar = e.target.closest('#sidebar');

  if (sbItem && sbItem.dataset.isdir === '1') {
    await doMove(paths, sbItem.dataset.path);
  } else if (sidebar) {
    await addFavorites(paths);             // drop on sidebar background → add favorite
  } else if (folderTile) {
    await doMove(paths, folderTile.dataset.path);
  } else if (e.target.closest('#content')) {
    await doMove(paths, state.cwd);        // drop from elsewhere → move into this folder
  }
});

async function doMove(paths, destDir) {
  const res = await api.move(paths, destDir);
  if (res.errors.length) statusEl.textContent = res.errors[0];
  else if (res.moved) statusEl.textContent = `Moved ${res.moved} item${res.moved === 1 ? '' : 's'}`;
  await refresh(true);
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------
function tileRects() {
  return [...sectionsEl.querySelectorAll('.tile')].map((t) => ({ idx: +t.dataset.idx, r: t.getBoundingClientRect(), el: t }));
}

function neighborIdx(fromIdx, dir) {
  const n = state.displayOrder.length;
  if (!n) return -1;
  if (fromIdx < 0) return 0;
  if (dir === 'left') return Math.max(0, fromIdx - 1);
  if (dir === 'right') return Math.min(n - 1, fromIdx + 1);

  const tiles = tileRects();
  const cur = tiles.find(t => t.idx === fromIdx);
  if (!cur) return fromIdx;
  const cx = (cur.r.left + cur.r.right) / 2;

  const cand = tiles.filter(t => dir === 'down' ? t.r.top > cur.r.top + 4 : t.r.top < cur.r.top - 4);
  if (!cand.length) return fromIdx;
  // Nearest row in that direction
  let rowTop;
  if (dir === 'down') rowTop = Math.min(...cand.map(t => t.r.top));
  else rowTop = Math.max(...cand.map(t => t.r.top));
  const row = cand.filter(t => Math.abs(t.r.top - rowTop) < 6);
  let best = row[0], bestDist = Infinity;
  for (const t of row) {
    const d = Math.abs(((t.r.left + t.r.right) / 2) - cx);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best.idx;
}

function moveSelectionKey(dir) {
  const target = neighborIdx(state.anchorIdx, dir);
  if (target < 0) return;
  selectOnly(target);
  const el = sectionsEl.querySelector(`.tile[data-idx="${target}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (state.renaming) return;

  // ---- Quick Look owns the keyboard while open ----
  if (qlOpen) {
    if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeQuickLook(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); qlStep(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); qlStep(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); qlRow('down'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); qlRow('up'); }
    return;
  }

  const meta = e.metaKey || e.ctrlKey;

  if (e.key === ' ' && !meta) {
    if (state.anchorIdx >= 0) { e.preventDefault(); openQuickLook(state.anchorIdx); }
    return;
  }
  if (e.key === 'Enter' && !meta) {
    if (state.selection.size === 1 && state.anchorIdx >= 0) { e.preventDefault(); startRename(state.anchorIdx); }
    return;
  }
  if ((e.key === 'Backspace' && meta) || e.key === 'Delete') {
    e.preventDefault();
    trashSelected();
    return;
  }
  if (meta && e.key === 'ArrowUp') {
    e.preventDefault();
    goToParent();
    return;
  }
  if (meta && e.key === 'ArrowDown') {
    e.preventDefault();
    openSelected();
    return;
  }
  if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.selection = new Set(state.displayOrder.map(en => en.path));
    updateSelectionClasses();
    return;
  }
  if (e.key === 'Escape') {
    state.selection.clear();
    state.anchorIdx = -1;
    updateSelectionClasses();
    return;
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !meta) {
    e.preventDefault();
    moveSelectionKey(e.key.replace('Arrow', '').toLowerCase());
  }
});

async function goToParent() {
  const info = await api.pathInfo(state.cwd);
  if (info.dirname && info.dirname !== state.cwd) navigate(info.dirname);
}

// ---------------------------------------------------------------------------
// Quick Look
// ---------------------------------------------------------------------------
let qlOpen = false;
let qlIdx = -1;
let qlCleanup = null;

const qlEl = $('#quicklook');
const qlBody = $('#ql-body');

function openQuickLook(idx) {
  if (!state.displayOrder.length) return;
  qlOpen = true;
  qlEl.style.display = '';
  renderQuickLook(idx);
}

function closeQuickLook() {
  qlOpen = false;
  qlEl.style.display = 'none';
  if (qlCleanup) { qlCleanup(); qlCleanup = null; }
  qlBody.textContent = '';
}

function qlStep(delta) {
  const n = state.displayOrder.length;
  if (!n) return;
  renderQuickLook((qlIdx + delta + n) % n);   // wraps end-of-line → next line, and around the ends
}

function qlRow(dir) {
  const target = neighborIdx(qlIdx, dir);
  if (target >= 0 && target !== qlIdx) renderQuickLook(target);
}

$('#ql-close').addEventListener('click', closeQuickLook);
qlEl.addEventListener('click', (e) => { if (e.target === qlEl) closeQuickLook(); });
$('#ql-open').addEventListener('click', () => {
  const en = state.displayOrder[qlIdx];
  if (en) api.openPath(en.path);
});

async function renderQuickLook(idx) {
  const en = state.displayOrder[idx];
  if (!en) return;
  qlIdx = idx;
  selectOnly(idx);
  const tileEl = sectionsEl.querySelector(`.tile[data-idx="${idx}"]`);
  if (tileEl) tileEl.scrollIntoView({ block: 'nearest' });

  if (qlCleanup) { qlCleanup(); qlCleanup = null; }
  qlBody.textContent = '';

  $('#ql-title').textContent = en.name;
  $('#ql-counter').textContent = `${idx + 1} of ${state.displayOrder.length}`;

  const dims = dimsCache.get(`${en.path}|${en.mtime}`);
  const capBits = [fmtSize(en.size)];
  if (dims) capBits.push(`${dims.w} × ${dims.h}`);
  capBits.push(new Date(en.birthtime).toLocaleString());
  $('#ql-caption').textContent = capBits.join('  ·  ');

  const kind = kindOf(en);
  const myIdx = idx; // guard against races when arrowing quickly

  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = qlfileUrl(en.path);
    img.addEventListener('load', () => {
      if (qlIdx !== myIdx) return;
      if (!dims && img.naturalWidth) {
        dimsCache.set(`${en.path}|${en.mtime}`, { w: img.naturalWidth, h: img.naturalHeight });
        $('#ql-caption').textContent = [fmtSize(en.size), `${img.naturalWidth} × ${img.naturalHeight}`, new Date(en.birthtime).toLocaleString()].join('  ·  ');
      }
    });
    qlBody.appendChild(img);
  } else if (kind === 'video') {
    const v = document.createElement('video');
    v.src = qlfileUrl(en.path);
    v.controls = true;
    v.autoplay = true;
    qlBody.appendChild(v);
    qlCleanup = () => { v.pause(); v.removeAttribute('src'); v.load(); };
  } else if (kind === 'audio') {
    const wrap = document.createElement('div');
    wrap.className = 'ql-fallback';
    wrap.innerHTML = '<div style="font-size:72px">🎵</div>';
    const a = document.createElement('audio');
    a.src = qlfileUrl(en.path);
    a.controls = true;
    a.autoplay = true;
    wrap.appendChild(a);
    qlBody.appendChild(wrap);
    qlCleanup = () => { a.pause(); a.removeAttribute('src'); a.load(); };
  } else if (kind === 'pdf') {
    const f = document.createElement('iframe');
    f.src = qlfileUrl(en.path);
    qlBody.appendChild(f);
  } else if (kind === 'model') {
    await renderModel(en, myIdx);
  } else if (kind === 'text' && !en.isDir) {
    const res = await api.readText(en.path, 256 * 1024);
    if (qlIdx !== myIdx) return;
    const pre = document.createElement('pre');
    pre.textContent = res.error ? `Could not read file: ${res.error}` : res.text + (res.truncated ? '\n\n… (truncated)' : '');
    qlBody.appendChild(pre);
  } else {
    await renderFallback(en, myIdx);
  }
}

async function renderFallback(en, myIdx) {
  const res = await api.getThumb(en.path, 512, en.mtime).catch(() => null);
  if (qlIdx !== myIdx) return;
  const wrap = document.createElement('div');
  wrap.className = 'ql-fallback';
  if (res && res.thumb) {
    const img = document.createElement('img');
    img.src = res.thumb;
    wrap.appendChild(img);
  }
  const nm = document.createElement('div');
  nm.className = 'big';
  nm.textContent = en.name;
  const meta = document.createElement('div');
  meta.textContent = en.isDir ? 'Folder' : `${(en.ext || 'file').toUpperCase()} · ${fmtSize(en.size)}`;
  wrap.append(nm, meta);
  qlBody.appendChild(wrap);
}

// ---- 3D preview for STL / 3MF -------------------------------------------
async function renderModel(en, myIdx) {
  if (typeof THREE === 'undefined') { renderFallback(en, myIdx); return; }
  const res = await api.readFile(en.path);
  if (qlIdx !== myIdx) return;
  if (res.error || !res.data) { renderFallback(en, myIdx); return; }

  let object;
  try {
    const u8 = new Uint8Array(res.data);
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    if (en.ext === 'stl') {
      const geom = new THREE.STLLoader().parse(buf);
      const mat = new THREE.MeshStandardMaterial({ color: 0x9aa4b0, metalness: 0.15, roughness: 0.7 });
      object = new THREE.Mesh(geom, mat);
    } else {
      object = new THREE.ThreeMFLoader().parse(buf);
      object.traverse((c) => {
        if (c.isMesh && (!c.material || !c.material.color)) {
          c.material = new THREE.MeshStandardMaterial({ color: 0x9aa4b0, metalness: 0.15, roughness: 0.7 });
        }
      });
    }
  } catch (err) {
    console.error('3D parse failed:', err);
    renderFallback(en, myIdx);
    return;
  }

  object.rotation.x = -Math.PI / 2; // STL/3MF are Z-up; three.js is Y-up

  const w = qlBody.clientWidth, h = qlBody.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(w, h);
  qlBody.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff, 0.7);
  dl.position.set(1, 2, 1.5);
  scene.add(dl);
  scene.add(object);

  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const camera = new THREE.PerspectiveCamera(45, w / h, maxDim / 100, maxDim * 20);
  camera.position.set(center.x + maxDim * 1.2, center.y + maxDim * 0.9, center.z + maxDim * 1.4);
  camera.lookAt(center);

  let controls = null;
  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.update();
  }

  let alive = true;
  (function loop() {
    if (!alive) return;
    requestAnimationFrame(loop);
    if (controls) controls.update();
    renderer.render(scene, camera);
  })();

  qlCleanup = () => {
    alive = false;
    if (controls) controls.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  };
}

// ---------------------------------------------------------------------------
// Toolbar toggles
// ---------------------------------------------------------------------------
function setGrouping(g) {
  state.grouping = g;
  for (const b of document.querySelectorAll('#group-toggle button')) {
    b.classList.toggle('active', b.dataset.group === g);
  }
  state.expanded.clear();
  api.setPrefs({ grouping: g });
  renderContent(false);
}
function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('#view-toggle button')) {
    b.classList.toggle('active', b.dataset.view === v);
  }
  api.setPrefs({ view: v });
  renderContent(false);
}

$('#group-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setGrouping(b.dataset.group);
});
$('#view-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setView(b.dataset.view);
});

api.onMenu((cmd) => {
  if (cmd === 'new-folder') newFolderHere();
  else if (cmd === 'group-day') setGrouping('day');
  else if (cmd === 'group-month') setGrouping('month');
  else if (cmd === 'view-grid') setView('grid');
  else if (cmd === 'view-feed') setView('feed');
});

// ---------------------------------------------------------------------------
// Live refresh + resize
// ---------------------------------------------------------------------------
api.onDirChanged(() => refresh(true));

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderContent(true), 180);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  try {
    await initInner();
  } catch (err) {
    showFatalError('Startup failed:\n' + (err && err.stack ? err.stack : String(err)));
  }
})();

async function initInner() {
  const prefs = await api.getPrefs();
  if (prefs.grouping === 'month') state.grouping = 'month';
  if (prefs.view === 'feed') state.view = 'feed';
  state.favorites = Array.isArray(prefs.favorites) ? prefs.favorites : [];

  for (const b of document.querySelectorAll('#group-toggle button')) {
    b.classList.toggle('active', b.dataset.group === state.grouping);
  }
  for (const b of document.querySelectorAll('#view-toggle button')) {
    b.classList.toggle('active', b.dataset.view === state.view);
  }

  state.places = await api.defaultPlaces();
  const home = state.places.find(p => p.kind === 'home');
  state.home = home ? home.path : '/';

  const downloads = state.places.find(p => p.kind === 'downloads');
  const start = (prefs.lastDir) || (downloads ? downloads.path : state.home);
  const info = await api.pathInfo(start);
  await navigate(info.exists && info.isDir ? start : state.home);

  // Remember last folder
  setInterval(() => { if (state.cwd) api.setPrefs({ lastDir: state.cwd }); }, 4000);

  if (api.smokeOk) api.smokeOk();
}
