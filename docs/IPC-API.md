# IPC API reference

> Technical docs are kept in English, matching the code comments.
> *La documentación técnica está en inglés, igual que los comentarios del código. El [README](../README.md) sí es bilingüe.*

The renderer's only way out of the sandbox is `window.musicAPI`, exposed by `src/preload.js` through `contextBridge`. Ten methods, all async, all `ipcRenderer.invoke` → `ipcMain.handle`. Every handler is defined in `src/main.js`.

Nothing throws across the bridge: every handler catches its own failures and returns `null` or an empty collection. The renderer is written to treat an empty result and a failure identically.

```js
window.musicAPI = {
  openFolder, readMusicFiles, getCoverArt,
  searchOnline, exploreHome, getAlbumTracks, getArtistTracks, getArtistAlbums,
  getYoutubeStream, youtubeResolve,
}
```

---

## Local filesystem

### `openFolder()`

Opens the native directory picker.

| | |
| --- | --- |
| **Channel** | `open-folder` |
| **Arguments** | none |
| **Returns** | `Promise<string \| null>` — the chosen absolute path, or `null` if cancelled |

---

### `readMusicFiles(folderPath)`

Recursively scans a folder for audio files. Unreadable directories are skipped silently rather than aborting the scan.

| | |
| --- | --- |
| **Channel** | `read-music-files` |
| **Arguments** | `folderPath: string` |
| **Returns** | `Promise<LocalTrack[]>` |

Accepted extensions: `.mp3`, `.flac`, `.wav`, `.ogg`, `.m4a`, `.aac` (case-insensitive).

```ts
interface LocalTrack {
  name:   string  // filename without extension
  path:   string  // absolute path
  album:  string  // parent directory name
  artist: string  // grandparent directory name
}
```

No tags are read here — artist and album come purely from the folder layout, and cover art is fetched later and lazily. A collection laid out as `Artist/Album/track.mp3` groups correctly; a flat folder produces one album named after that folder.

---

### `getCoverArt(filePath)`

Extracts the first embedded picture from a file with `music-metadata`.

| | |
| --- | --- |
| **Channel** | `get-cover-art` |
| **Arguments** | `filePath: string` |
| **Returns** | `Promise<string \| null>` — a `data:<mime>;base64,…` URI, or `null` if the file has no picture or cannot be parsed |

Called one file at a time by the renderer's `IntersectionObserver`, and memoised in `artCache`. Duration parsing is disabled (`duration: false`) because only the picture is needed.

---

## Online metadata (Deezer)

All four handlers below hit `https://api.deezer.com` with no key and no account, and are used for **metadata only** — names, covers, tracklists and charts. Deezer's own audio previews are never used. Any network or parse failure returns the empty shape.

### `searchOnline(query)`

| | |
| --- | --- |
| **Channel** | `search-online` |
| **Arguments** | `query: string` |
| **Returns** | `Promise<{ tracks: Track[], albums: Album[], artists: Artist[] }>` |

Runs three Deezer searches in parallel: 30 tracks, 15 albums, 12 artists. An empty or blank query short-circuits to empty arrays without a request.

---

### `exploreHome()`

The landing state of the Explore tab: Deezer's current charts.

| | |
| --- | --- |
| **Channel** | `explore-home` |
| **Arguments** | none |
| **Returns** | `Promise<{ tracks: Track[], albums: Album[], artists: Artist[] }>` — up to 20 of each |

---

### `getAlbumTracks(albumId)`

| | |
| --- | --- |
| **Channel** | `get-album-tracks` |
| **Arguments** | `albumId: number \| string` |
| **Returns** | `Promise<Track[]>` — up to 100 |

Fetches the album and its tracklist in parallel, because Deezer's tracklist endpoint omits the cover, the album title and the album artist. Those three are injected into every returned track — which is what makes `albumArtist` correct for collaborations, and therefore what keeps one album from splitting into several in the library grid.

---

### `getArtistTracks(artistId)`

| | |
| --- | --- |
| **Channel** | `get-artist-tracks` |
| **Arguments** | `artistId: number \| string` |
| **Returns** | `Promise<Track[]>` — the artist's top 50 |

---

### `getArtistAlbums(artistId)`

| | |
| --- | --- |
| **Channel** | `get-artist-albums` |
| **Arguments** | `artistId: number \| string` |
| **Returns** | `Promise<Album[]>` — up to 50 |

---

### Returned shapes

```ts
interface Track {
  id:          string   // 'dz' + Deezer track id
  title:       string
  artist:      string
  artistId:    number | null
  album:       string
  albumArtist: string   // the record's main artist — used for grouping
  duration:    number   // seconds
  artUrl:      string   // album cover, falling back to the artist picture
  source:      'deezer'
  query:       string   // "artist title" — what gets searched on YouTube at play time
}

interface Album {
  id: number; name: string; artist: string; artUrl: string; trackCount: number
}

interface Artist {
  id: number; name: string; artUrl: string; trackCount: number  // album count, in practice
}
```

---

## Audio resolution (YouTube via yt-dlp)

> ⚠️ These two handlers are the part of the app covered by the warning in the [README](../README.md#-legal-and-scope). Extracting audio from YouTube violates YouTube's Terms of Service; this is for personal use and must not ship in anything sold, published or distributed with the binary.

Both resolve a **fresh, short-lived** audio URL and are called at the moment of playback, never in advance.

### `getYoutubeStream(videoId, quality)`

For a track whose YouTube video id is already known (`source === 'youtube'`).

| | |
| --- | --- |
| **Channel** | `get-youtube-stream` |
| **Arguments** | `videoId: string`, `quality: 'high' \| 'medium' \| 'low'` |
| **Returns** | `Promise<string \| null>` — a direct audio URL |

---

### `youtubeResolve(query, quality)`

The path a Deezer track takes to become playable: search, then extract.

| | |
| --- | --- |
| **Channel** | `youtube-resolve` |
| **Arguments** | `query: string` (typically `"artist title"`), `quality: 'high' \| 'medium' \| 'low'` |
| **Returns** | `Promise<string \| null>` |

1. `youtube-sr` searches the query and takes hit #1 (`limit: 1, type: 'video'`).
2. `yt-dlp -f <selector> -g --no-playlist https://www.youtube.com/watch?v=<id>` prints the direct URL; the first line of stdout is used.

Returns `null` if the query is blank, the search finds nothing, or `yt-dlp` fails or times out.

**Quality selectors**

| `quality` | `yt-dlp -f` |
| --- | --- |
| `high` (default) | `bestaudio[ext=m4a]/bestaudio` |
| `medium` | `bestaudio[abr<=128][ext=m4a]/bestaudio[abr<=128]/bestaudio` |
| `low` | `bestaudio[abr<=64][ext=m4a]/bestaudio[abr<=64]/bestaudio` |

**Binary lookup** — `ytDlpPath()` tries, in order:

1. `process.resourcesPath/bin/yt-dlp.exe` — a packaged build (`extraResource: ['./bin']`)
2. `app.getAppPath()/bin/yt-dlp.exe` — running from source
3. `yt-dlp` on the system `PATH`

**Child process limits** — `execFile` with `timeout: 30_000`, `maxBuffer: 4 MB`, `windowsHide: true`.

---

## Replacing the audio source

The whole YouTube dependency is three functions and two handlers in `src/main.js`: `ytDlpPath()`, `youtubeSearchId()`, `resolveYoutubeUrl()`, plus `get-youtube-stream` and `youtube-resolve`.

Any replacement only has to honour the same contract — *given a query or an id and a quality, return a URL the `<audio>` element can play, or `null`*. Nothing in the renderer knows where the URL came from, so a licensed source drops in without touching the UI.
