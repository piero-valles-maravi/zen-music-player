/**
 * Zen Music Player — Electron main process.
 *
 * Everything that touches the disk, the network or a child process lives here;
 * the renderer reaches it only through the `window.musicAPI` bridge defined in
 * preload.js. Four groups of handlers:
 *
 *   1. Local library  — folder picker, recursive audio scan, embedded cover art.
 *   2. Deezer         — metadata only (search, charts, album and artist tracks).
 *   3. YouTube        — play-time audio URL resolution via yt-dlp (see the note
 *                       above that section before reusing this code).
 *   4. App lifecycle  — window creation, activate/quit.
 *
 * No handler throws across the bridge: failures collapse to `null` or an empty
 * collection, and the renderer treats "empty" and "failed" the same way.
 *
 * Docs: ../docs/ARCHITECTURE.md · IPC contract: ../docs/IPC-API.md
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import started from 'electron-squirrel-startup';

if (started) app.quit();

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Needed so one document can load `file://` audio from the user's folder
      // and remote cover art at the same time. A real relaxation of Electron's
      // sandbox — acceptable while the window only ever loads our own UI, and
      // the first thing to revisit before rendering third-party content.
      webSecurity: false,
    },
    backgroundColor: '#f9f9f7',
    autoHideMenuBar: true,
    title: 'Zen Music Player',
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  mainWindow.maximize();
};

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('read-music-files', async (_event, folderPath) => {
  const extensions = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac'];

  function scanDir(dir) {
    let results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(scanDir(fullPath));
        } else if (extensions.includes(path.extname(entry.name).toLowerCase())) {
          results.push({
            name: path.basename(entry.name, path.extname(entry.name)),
            path: fullPath,
            album: path.basename(path.dirname(fullPath)),
            artist: path.basename(path.dirname(path.dirname(fullPath))),
          });
        }
      }
    } catch {}
    return results;
  }

  return scanDir(folderPath);
});

ipcMain.handle('get-cover-art', async (_event, filePath) => {
  try {
    const { parseFile } = await import('music-metadata');
    const metadata = await parseFile(filePath, { skipCovers: false, duration: false });
    const cover = metadata.common.picture?.[0];
    if (!cover) return null;
    return `data:${cover.format};base64,${Buffer.from(cover.data).toString('base64')}`;
  } catch {
    return null;
  }
});

/* ===== MUSIC METADATA (Deezer) =====
   Deezer has a huge public catalog of real artists/albums (free, no API key).
   Used ONLY for metadata (names, covers, tracklists); the actual audio is
   resolved separately at play time. */
const DEEZER = 'https://api.deezer.com';
async function deezer(pathQuery) {
  try {
    const res = await fetch(`${DEEZER}${pathQuery}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const dzTrack = (t, coverFallback, albumFallback, albumArtistFallback) => ({
  id: 'dz' + t.id,
  title: t.title || t.title_short || '(sin título)',
  artist: (t.artist && t.artist.name) || 'Artista desconocido',
  artistId: (t.artist && t.artist.id) || null,
  album: (t.album && t.album.title) || albumFallback || '',
  // Album artist (the record's main artist) — used to group albums so that
  // featured/collab tracks don't split one album into several.
  albumArtist: albumArtistFallback || (t.artist && t.artist.name) || '',
  duration: t.duration || 0,
  artUrl: (t.album && (t.album.cover_medium || t.album.cover_big)) || coverFallback
          || (t.artist && t.artist.picture_medium) || '',
  source: 'deezer',
  query: `${(t.artist && t.artist.name) || ''} ${t.title || ''}`.trim(),
});
const dzAlbum = a => ({
  id: a.id,
  name: a.title || '(sin título)',
  artist: (a.artist && a.artist.name) || '',
  artUrl: a.cover_medium || a.cover_big || '',
  trackCount: a.nb_tracks || 0,
});
const dzArtist = a => ({
  id: a.id,
  name: a.name || 'Artista',
  artUrl: a.picture_medium || a.picture_big || '',
  trackCount: a.nb_album || 0,
});

// Search: real artists, albums and songs (metadata only).
ipcMain.handle('search-online', async (_event, query) => {
  const empty = { tracks: [], albums: [], artists: [] };
  if (!query || !query.trim()) return empty;
  const q = encodeURIComponent(query.trim());
  const [tr, al, ar] = await Promise.all([
    deezer(`/search?q=${q}&limit=30`),
    deezer(`/search/album?q=${q}&limit=15`),
    deezer(`/search/artist?q=${q}&limit=12`),
  ]);
  return {
    tracks: ((tr && tr.data) || []).map(t => dzTrack(t)),
    albums: ((al && al.data) || []).map(dzAlbum),
    artists: ((ar && ar.data) || []).map(dzArtist),
  };
});

// Explore home: current charts (most popular songs, albums and artists).
ipcMain.handle('explore-home', async () => {
  const c = await deezer('/chart?limit=20');
  if (!c) return { tracks: [], albums: [], artists: [] };
  return {
    tracks: ((c.tracks && c.tracks.data) || []).map(t => dzTrack(t)),
    albums: ((c.albums && c.albums.data) || []).map(dzAlbum),
    artists: ((c.artists && c.artists.data) || []).map(dzArtist),
  };
});

// Tracks inside an album (cover is injected because the tracklist omits it).
ipcMain.handle('get-album-tracks', async (_event, albumId) => {
  const [alb, tr] = await Promise.all([
    deezer(`/album/${albumId}`),
    deezer(`/album/${albumId}/tracks?limit=100`),
  ]);
  const cover = alb ? (alb.cover_medium || alb.cover_big || '') : '';
  const albName = alb ? (alb.title || '') : '';
  const albArtist = alb && alb.artist ? (alb.artist.name || '') : '';
  return ((tr && tr.data) || []).map(t => dzTrack(t, cover, albName, albArtist));
});

// An artist's most popular tracks.
ipcMain.handle('get-artist-tracks', async (_event, artistId) => {
  const tr = await deezer(`/artist/${artistId}/top?limit=50`);
  return ((tr && tr.data) || []).map(t => dzTrack(t));
});

// An artist's albums.
ipcMain.handle('get-artist-albums', async (_event, artistId) => {
  const al = await deezer(`/artist/${artistId}/albums?limit=50`);
  return ((al && al.data) || []).map(dzAlbum);
});

/* ===== YOUTUBE (via yt-dlp) =====
   NOTE: Extracting YouTube audio violates YouTube's Terms of Service. This is for
   PERSONAL use only and must NOT ship in a version that is sold or published. */
function ytDlpPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'yt-dlp.exe'),
    path.join(app.getAppPath(), 'bin', 'yt-dlp.exe'),
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'yt-dlp'; // fall back to a yt-dlp on PATH
}

// Find the best matching YouTube video id for a text query.
async function youtubeSearchId(query) {
  try {
    const mod = await import('youtube-sr');
    const YouTube = mod.default || mod;
    const results = await YouTube.search(query.trim(), { limit: 1, type: 'video' });
    return (results && results[0] && results[0].id) || null;
  } catch {
    return null;
  }
}

// Map quality string to a yt-dlp format selector.
function qualityFormat(q) {
  if (q === 'medium') return 'bestaudio[abr<=128][ext=m4a]/bestaudio[abr<=128]/bestaudio';
  if (q === 'low')    return 'bestaudio[abr<=64][ext=m4a]/bestaudio[abr<=64]/bestaudio';
  return 'bestaudio[ext=m4a]/bestaudio'; // high (default — best available)
}

// Resolve a fresh, playable audio URL for a YouTube video id (URLs expire, so we
// resolve on demand at play time rather than up front).
function resolveYoutubeUrl(videoId, format) {
  return new Promise(resolve => {
    if (!videoId) return resolve(null);
    execFile(
      ytDlpPath(),
      ['-f', format || 'bestaudio[ext=m4a]/bestaudio', '-g', '--no-playlist',
       `https://www.youtube.com/watch?v=${videoId}`],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const url = (stdout || '').trim().split('\n')[0];
        resolve(url || null);
      }
    );
  });
}

// Play-time resolution for a known YouTube video id.
ipcMain.handle('get-youtube-stream', (_event, videoId, quality) => resolveYoutubeUrl(videoId, qualityFormat(quality)));

// Play-time resolution for a metadata track: search YouTube by "artist title",
// then extract its audio URL. This is how a Deezer track becomes playable.
ipcMain.handle('youtube-resolve', async (_event, query, quality) => {
  if (!query || !query.trim()) return null;
  const videoId = await youtubeSearchId(query);
  if (!videoId) return null;
  return resolveYoutubeUrl(videoId, qualityFormat(quality));
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
