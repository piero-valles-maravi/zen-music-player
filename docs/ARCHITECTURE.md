# Architecture

> Technical docs are kept in English, matching the code comments.
> *La documentación técnica está en inglés, igual que los comentarios del código. El [README](../README.md) sí es bilingüe.*

This document explains how Zen Music Player is put together: the process model, the shape of the data, how a click becomes audio, and where state lives. For the exact signature of every IPC channel see [IPC-API.md](IPC-API.md); for what is still missing see [ROADMAP.md](ROADMAP.md).

---

## 1. Process model

Standard Electron three-layer split, with no framework anywhere:

```
┌──────────────────────────────────────────────────────────────┐
│ MAIN PROCESS — src/main.js (Node)                            │
│  • BrowserWindow lifecycle                                   │
│  • Filesystem: recursive folder scan, cover-art extraction   │
│  • Network: Deezer public API (metadata)                     │
│  • Child process: yt-dlp (audio URL resolution)              │
└───────────────────────────┬──────────────────────────────────┘
                            │ ipcMain.handle / ipcRenderer.invoke
┌───────────────────────────┴──────────────────────────────────┐
│ PRELOAD — src/preload.js (isolated)                          │
│  contextBridge → window.musicAPI  (10 async methods)         │
└───────────────────────────┬──────────────────────────────────┘
                            │ window.musicAPI.*
┌───────────────────────────┴──────────────────────────────────┐
│ RENDERER — src/renderer.js + index.html + src/index.css      │
│  • All application state (module-level variables)            │
│  • All rendering (imperative DOM, no virtual DOM)            │
│  • Playback via a single detached `new Audio()` element      │
│  • Persistence via localStorage                              │
└──────────────────────────────────────────────────────────────┘
```

Everything that touches the disk, the network or a child process lives in the main process. The renderer never imports `node:*` — its only way out is `window.musicAPI`.

### Build pipeline

Electron Forge with the Vite plugin (`forge.config.js`):

| Target | Entry | Vite config |
| --- | --- | --- |
| `main` | `src/main.js` | `vite.main.config.mjs` |
| `preload` | `src/preload.js` | `vite.preload.config.mjs` |
| `renderer` (`main_window`) | `index.html` → `src/renderer.js` | `vite.renderer.config.mjs` |

Two globals are injected by the Forge Vite plugin and used in `createWindow()`:

- `MAIN_WINDOW_VITE_DEV_SERVER_URL` — set in development, so the window loads from the Vite dev server with HMR.
- `MAIN_WINDOW_VITE_NAME` — used in production to build the path to the bundled `index.html`.

`packagerConfig.extraResource: ['./bin']` copies the `bin/` folder next to the packaged app, which is how `ytDlpPath()` finds the binary at `process.resourcesPath/bin/yt-dlp.exe` in a build. Electron fuses are enabled to disable `RunAsNode`, `NODE_OPTIONS` and CLI inspect arguments, and to require ASAR integrity.

### Window configuration

```js
new BrowserWindow({
  width: 1400, height: 900, minWidth: 900, minHeight: 600,
  webPreferences: { preload, webSecurity: false },
  backgroundColor: '#f9f9f7', autoHideMenuBar: true,
})
```

`webSecurity: false` is the one deliberate relaxation. The renderer has to load `file://` audio from an arbitrary user folder *and* remote cover art from Deezer's CDN in the same document; with web security on, the page's origin blocks the local files. Context isolation stays on and the preload surface stays minimal, so the renderer still has no Node access — but this is the first thing to revisit if the app ever renders third-party content.

---

## 2. The track object

Everything in the renderer is an index into one flat `tracks` array. Two kinds of entry live in it, distinguished by `online`:

**Local track** — produced by the `read-music-files` scan:

```js
{
  name:   'Bohemian Rhapsody',      // filename without extension
  path:   'D:\\Music\\Queen\\...',  // absolute path — also the identity key
  album:  'A Night at the Opera',   // parent directory name
  artist: 'Queen',                  // grandparent directory name
}
```

**Online track** — produced by `ingestTrack()` from a Deezer (or direct YouTube) result:

```js
{
  name, artist, album, albumArtist, genre,
  artistId,                   // Deezer artist id, for drill-down
  online:    true,
  source:    'deezer' | 'youtube',
  path:      'deezer:3135556',   // synthetic id — identity key, same role as a file path
  inLibrary: false,              // true once the user adds it
  videoId:   null,               // set only when source === 'youtube'
  query:     'Daft Punk Get Lucky', // what gets searched on YouTube at play time
  stream:    null,               // a ready-made URL, if the source provided one
  duration:  248,
  _stream:   undefined,          // session-only cache of the resolved audio URL
}
```

Three consequences of this design worth knowing before changing it:

1. **`path` is the identity key for everything.** Ratings, favorites, the art cache and the online index are all keyed by it. Local files therefore lose their ratings if the collection moves to another drive.
2. **`tracks` is append-only within a session.** `onlineIndex` (a `Map` from `path` → index) makes `ingestTrack()` idempotent, so re-searching the same song reuses the existing entry instead of duplicating it.
3. **`_stream` is deliberately not persisted.** Resolved YouTube URLs expire; see §4.

### Library membership

`inLib(t)` is `!t.online || t.inLibrary`. Only tracks that satisfy it appear in the Artists / Albums / Songs / Favorites tabs. Online results live in `tracks` from the moment they are rendered in Explore, but stay invisible to the library until the user presses **＋**.

### Grouping

`groupByAlbum()` and `groupByArtist()` fold `tracks` into `{ album, artist, tracks: [idx], artFile, online }` groups on every render. They are cheap enough to recompute rather than cache.

The important detail is `albumArtistOf(t) = t.albumArtist || t.artist`. Grouping by the *track* artist splits `Random Access Memories` into one album per featured guest. Deezer's `/album/{id}` endpoint gives the record's main artist, which `dzTrack()` propagates onto every track of that album as `albumArtist`.

Libraries saved before `albumArtist` existed are repaired on load by `migrateAlbumArtists()`: for each album whose tracks disagree about the album artist, the most frequent track artist wins, and the corrected library is written back.

---

## 3. Rendering

There is no virtual DOM and no reactive layer. `renderLibrary()` clears `#track-list` and rebuilds it from current state; every mutation that should be visible calls it again. At collection sizes this app targets, that is fast and it removes a whole class of stale-state bugs.

```
renderLibrary()
├── Cover Flow on?  → renderCoverFlow()
└── else, by tab:
    ├── artists   → renderGrid(groupByArtist(), 'artist', …)
    ├── albums    → renderGrid(groupByAlbum(),  'album',  …)
    ├── songs     → renderSongsTab()
    ├── favorites → renderFavoritesTab()
    └── search    → renderExplore()
```

### Lazy cover art

Reading embedded art for a few thousand files during the scan would freeze the app, so the scan returns no art at all. Instead:

- `initThumbObserver()` sets up an `IntersectionObserver` with a `200px` root margin.
- Every card's art container carries `data-src` (the file path it needs art for).
- When a card approaches the viewport, `loadArt(path)` calls `get-cover-art` over IPC, which uses `music-metadata` to pull the first embedded picture and returns it as a `data:` URI.
- Results are memoised in `artCache` (`Map<path, dataURI|null>`). For online tracks the cache is pre-filled with the Deezer cover URL at ingest time, so those never hit IPC.

### Grid cards

`renderGrid()` builds both album and artist cards. Two behaviours are worth noting:

**Single click vs double click.** Cards need both. The click handler starts a 260 ms timer stored in `clickTimers` keyed by the card's identity; a second click inside that window cancels the timer and plays the group, and the timer firing opens the detail panel instead. The play overlay clears the pending timer before playing, so hitting play never also opens the detail.

**The artist album stack.** An artist card renders up to three `.stack-album` tiles that fan out from behind it on hover. They are rendered in reverse DOM order so that `--si:0` (the front card) paints on top, each is observed by the same thumbnail observer, and clicking one opens that album directly. The artist card's own art slot deliberately has no `data-src`, keeping the person placeholder visible behind the stack.

### Detail views

Two modes, switchable in Settings:

- **`bottom`** — `#detail-panel`, a docked panel with its own header (title, thumbnail-size slider, view-mode buttons, *Reproducir todo*). For an artist it shows an album chip list plus the tracks of the selected album.
- **`inline`** — a MusicBee-style expansion injected into the grid after the last card of the clicked card's row (`getLastCardInRow()` compares `offsetTop` to find the row boundary).

Both share four track layouts — `list`, `columns`, `table`, `compact` — selected by `detailViewMode` and rendered by `buildTrackRow()`, `buildCompactRow()` and `buildTableView()`.

### Cover Flow

`renderCoverFlow()` replaces the grid with a 3D carousel over the current tab's groups.

- `cfIndex` is the centred item; `setCfIndex()` moves it, `updateCfPositions()` applies the transforms.
- `cfEffect` (0–100) interpolates between a flat strip and a full 3D fan.
- `cfFilter` filters live from the search row; `cfArtistAlbumIdx` remembers which album is selected per artist when the carousel is showing artists.
- The blurred backdrop (`#cf-bg`) is the centred cover, scaled up.
- `←` / `→` are bound at document level, active only while Cover Flow is on.

---

## 4. Playback

### The pipeline

```
playTrack(idx, newQueue, mode)
  │
  ├─ local track  → src = file:// + path (backslashes normalised)
  │
  └─ online track → cached _stream?      → use it
                    source 'youtube'?    → get-youtube-stream(videoId, quality)
                    otherwise (Deezer)   → youtube-resolve(query, quality)
                                             ├─ youtube-sr: search "artist title", take hit #1
                                             └─ yt-dlp -g -f <selector> → direct audio URL
  │
  └─ elAudio.src = src; elAudio.play()
```

**Why resolution happens at play time.** `yt-dlp -g` returns a signed URL that expires. Resolving a whole album up front would mean most of those URLs are dead before you reach them, and persisting them would produce a library of broken links. So each track resolves on demand and caches the result in `_stream` for the current session only.

**The single retry.** The `<audio>` `error` handler checks `ytRetried`. If an online track fails and has not been retried, it clears `_stream` and calls `playTrack()` again, which forces a fresh resolve. That one retry is what makes an expired URL invisible to the user. `ytRetried` resets on every new `playTrack()` call, so a genuinely unplayable track fails after exactly two attempts rather than looping.

**Race protection.** After the `await` that resolves a URL, `playTrack()` compares `currentIndex` with the `idx` it was called for and bails out if the user has since changed tracks.

### Streaming quality

`qualityFormat()` maps the setting to a `yt-dlp` format selector:

| Setting | Selector |
| --- | --- |
| `high` (default) | `bestaudio[ext=m4a]/bestaudio` |
| `medium` | `bestaudio[abr<=128][ext=m4a]/bestaudio[abr<=128]/bestaudio` |
| `low` | `bestaudio[abr<=64][ext=m4a]/bestaudio[abr<=64]/bestaudio` |

The setting applies to the next resolution; tracks already cached in `_stream` keep the quality they were resolved at.

### Queue

`queue` is an array of track indices, `queuePos` the current position, `queueMode` is `'album'` or `'artist'` (it only affects how the queue is labelled). Playing an album or artist replaces the queue wholesale; the context menu's *Agregar al final de la cola* pushes onto it.

`ended` advances to `queuePos + 1` and stops at the end — there is no shuffle and no repeat yet. `btn-prev` restarts the current track if more than 3 seconds have elapsed, otherwise steps back.

### Player chrome

One `Audio` object drives two UIs that are always kept in sync: the full player card (`#player`) and the collapsed mini-bar (`#mini-bar`). `setCollapsed()` switches between them; the resize handle drags `#player`'s width. The mini-bar carries its own transport, volume, star rating and favorite button.

---

## 5. Online metadata

All of it goes through one helper:

```js
const DEEZER = 'https://api.deezer.com';
async function deezer(pathQuery) { /* fetch, null on any failure */ }
```

No key, no account, no rate-limit handling — every failure collapses to `null` and the renderer shows an empty or error state. `dzTrack()`, `dzAlbum()` and `dzArtist()` normalise Deezer's payloads into the app's own shapes, which is the only place the external format is allowed to leak in.

The Explore tab has three states driven by `exploreView`:

- `browse` — charts (`explore-home`) when idle, or search results (`search-online`) after a query.
- `album` — an album's tracklist (`get-album-tracks`).
- `artist` — an artist's top tracks and albums (`get-artist-tracks`, `get-artist-albums`).

Deezer's own 30-second previews are never used; audio always comes from the YouTube path.

---

## 6. Persistence

Two `localStorage` keys, no database, no config file.

### `zen-prefs-v5`

Written by `savePrefs()` on every meaningful change, read by `loadPrefs()` at startup:

```
theme · gridSize · detailViewMode · detailPosMode · collapsed
cfMode · cfEffect · streamQuality · thumbSize · volume
ratings {path: 1–5} · favorites [path] · favSortBy · favMinStars
folderPath
```

The `v5` suffix is the schema version: bumping it abandons older preference shapes instead of migrating them.

### `zen-library-v1`

Written by `saveLibrary()`, which serialises every track with `online && inLibrary`, keeping enough metadata (`title`, `artist`, `album`, `albumArtist`, `artUrl`, `duration`, `query`, `videoId`) to rebuild the entry without a network call. `loadLibrary()` feeds each record back through `ingestTrack()` and flags it `inLibrary`, then runs `migrateAlbumArtists()`.

### Startup sequence

```
initThumbObserver()
loadPrefs()
folderPath saved?
  ├─ yes → readMusicFiles(folderPath) → tracks = localFiles
  │         → clear artCache + onlineIndex → loadLibrary() → renderLibrary()
  └─ no  → loadLibrary() → renderLibrary()
```

The local scan runs first and *replaces* `tracks`, so the online library has to be re-ingested afterwards — which is why `loadLibrary()` is inside the promise chain and also in its rejection path.

---

## 7. Styling

`src/index.css` is one file, organised by component, with all theming done through CSS custom properties. Each theme is a single selector defining the same variable set:

```css
:root,[data-theme="white"]{ --bg:…; --surface:…; --accent:…; --player-bg:…; … }
[data-theme="midnight"]{ … }
```

`applyTheme()` sets `data-theme` on `<html>`; nothing else in the app knows a colour. Adding a theme means adding one selector with the full variable set and one `.theme-dot` button in `index.html` — no JavaScript change.

Two runtime-driven variables are set from JS rather than by theme: `--grid-size` (the grid size slider) and `--detail-thumb-size` (the thumbnail slider).

---

## 8. Where to change things

| You want to… | Go to |
| --- | --- |
| Support another audio extension | `extensions` array in the `read-music-files` handler, `src/main.js` |
| Replace the metadata source | `dzTrack` / `dzAlbum` / `dzArtist` + the five Deezer handlers, `src/main.js` |
| Replace or remove the audio source | `youtubeSearchId`, `resolveYoutubeUrl`, `qualityFormat`, `src/main.js` — and the two handlers in [IPC-API.md](IPC-API.md) |
| Add shuffle or repeat | The `ended` handler and the queue block, `src/renderer.js` |
| Add a theme | One selector in `src/index.css` + one `.theme-dot` in `index.html` |
| Add a persisted setting | `savePrefs()` / `loadPrefs()`, `src/renderer.js` |
| Change what a right click offers | `trackCtxMenu()` and the `contextmenu` listener, `src/renderer.js` |
