# Finder Viewer

A macOS Finder-style file viewer built with Electron, styled after Big Sur.

## Features

- **Grouped by day** — every file is filed under the day it was created/downloaded (no bunching old files by month/year). Empty days simply don't appear.
- **Group by month** — toggle in the top-right toolbar (or `⌘1` / `⌘2`).
- **See All (N)** — each day collapses to a single row when it overflows; click *See All* to drop the whole day down, *Show Less* to collapse again.
- **Feed view** — Instagram-style view (`⌘4`): every file large, full-width, one long scroll, no collapsing. `⌘3` returns to the grid.
- **File captions** — name, file size, and pixel dimensions (for images) under every file in every view.
- **Finder-style interaction**
  - Click to select, ⌘-click to multi-select, ⇧-click for ranges, ⌘A select all
  - Double-click to open (folders navigate, files open in their default app)
  - `Enter` to rename (extension pre-deselected, just like Finder)
  - `⌘⌫` or `Delete` → Move to Trash
  - `⌘↑` go to parent folder, `⌘↓` open selection
  - Right-click context menu: Open, Quick Look, Rename, Move to Trash, Add to Sidebar, New Folder
- **Quick Look**
  - Press `Space`, **⌥-click (hold Option and click)** a file, or use the 👁 button that appears in the top-right corner of every tile
  - Previews images, video, audio, text/code, PDF — and **STL / 3MF models** in an orbitable 3D viewer (three.js)
  - `←`/`→` step through every file (end of a line flows onto the next line, and wraps around), `↑`/`↓` jump a visual row
- **Sidebar** — Home/Desktop/Documents/Downloads/Pictures/Movies/Music, plus your own favorites: **drag any file or folder onto the sidebar** to pin it (right-click → Remove from Sidebar).
- **Real file management** — drag files onto any folder tile or sidebar folder to move them; drags are native, so you can also drag straight out into the real Finder. Renames, moves and trash all act on the real filesystem, and the view live-refreshes when the folder changes on disk.
- **Hidden files are always shown.**
- **No freeze on big folders** — thumbnails are generated lazily, only for tiles near the viewport, a few at a time (small thumbs in grid view, larger ones in feed view), appearing automatically as you scroll. Collapsed rows don't even build DOM for their hidden files.

Thumbnails use the system thumbnailer (Quick Look on macOS), so anything macOS can preview — including STL/3MF if you have a Quick Look plugin for them — shows a real preview; everything else gets its proper system file icon.

## Run it

```bash
npm install
npm start
```

## Build for macOS

```bash
npm install
npm run dist        # produces a universal (Intel + Apple Silicon) .dmg and .zip in dist/
```

Build on a Mac for best results (DMG creation and universal binaries require macOS tooling). The app targets macOS 10.15 Catalina and later — that's the oldest version modern Electron can support — and runs natively on both Intel and Apple Silicon, including Big Sur 11.

The build is unsigned (`identity: null`); on first launch right-click the app → Open to get past Gatekeeper, or sign it with your own Developer ID.
