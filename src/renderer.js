/**
 * Zen Music Player — renderer.
 *
 * The whole interface, in vanilla JS: no framework, no virtual DOM, no reactive
 * layer. State lives in the module-level variables below; anything that should
 * become visible mutates one of them and calls `renderLibrary()`, which clears
 * `#track-list` and rebuilds it.
 *
 * Everything is an index into the flat `tracks` array, which holds two kinds of
 * entry distinguished by `online`: files found by the folder scan, and catalog
 * results ingested from Deezer. `path` is the identity key for both — an
 * absolute path for local files, a synthetic `source:id` for online ones — and
 * ratings, favorites and the art cache are all keyed by it.
 *
 * Sections, in order: state · DOM helpers · lazy art · grouping · tabs ·
 * library grids · Explore · detail panels · track rows · playback · queue ·
 * Cover Flow · theme · prefs · context menu · init.
 *
 * Docs: ../docs/ARCHITECTURE.md
 */

import './index.css';

/* ===== STATE ===== */
let tracks = [], currentIndex = -1, isPlaying = false;
let currentTab = 'albums';
let detailViewMode = 'list';
let detailPosMode = 'bottom';
let detailOpenKey = null, detailOpenType = null, detailAlbumFilter = null;
let queue = [], queuePos = -1, queueMode = 'album';
let expandedQueueAlbum = null;
let cfMode = false, cfIndex = 0, cfAlbums = [];
let cfEffect = 70; // 0=flat, 100=full 3D
let cfFilter = '';  // text filter for Cover Flow
let cfArtistAlbumIdx = {}; // artistName → selected album index
let streamQuality = 'high'; // 'high' | 'medium' | 'low'
let ratings = {}, favorites = new Set();
let lastFolderPath = null;   // persisted across sessions
let favSortBy = 'default';   // 'default' | 'rating'
let favMinStars = 0;         // 0–5: minimum rating to include in favorites tab
const artCache = new Map();
const clickTimers = new Map();

/* online / explore state */
let searchQuery = '', searchState = 'idle';          // idle|loading|done|error
let searchResults = { tracks: [], albums: [], artists: [] };
let exploreView = 'browse';                            // browse|album|artist
let exploreHome = null;                                // {tracks:[idx], albums:[obj], artists:[obj]}
let exploreDetail = null;                              // {type,id,name,sub,artUrl,trackIdxs}
let libFilter = '';                                    // filter text for the local library tabs
const onlineIndex = new Map();                         // online path -> index in tracks[]

const PREF_KEY = 'zen-prefs-v5';

/* ===== DOM HELPERS ===== */
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

/* ===== ELEMENTS ===== */
const elTrackList   = $('track-list');
const elDetailPanel = $('detail-panel');
const elDetailTitle = $('detail-title');
const elDetailAlbums= $('detail-albums');
const elDetailSongs = $('detail-songs');
const elAudio       = new Audio();
const elCoverArt    = $('cover-art');
const elTrackTitle  = $('track-title');
const elTrackArtist = $('track-artist');
const elTrackAlbum  = $('track-album');
const elProgress    = $('progress-fill');
const elThumb       = $('progress-thumb');
const elTimeCur     = $('time-current');
const elTimeTot     = $('time-total');
const elQueueList   = $('queue-list');
const elQueuePos    = $('queue-pos');
const elVolumeSlider= $('volume-slider');
const elMiniBar     = $('mini-bar');
const elMbArt       = $('mb-art');
const elMbTitle     = $('mb-title');
const elMbArtist    = $('mb-artist');
const elMbProgFill  = $('mb-prog-fill');
const elMbTimeCur   = $('mb-time-cur');
const elMbTimeTot   = $('mb-time-tot');
const elMbVolume    = $('mb-volume');
const elMbStars     = $('mb-stars');
const elMbFav       = $('mb-fav');
const elMbPlayIcon  = $('mb-icon-play');
const elMbPauseIcon = $('mb-icon-pause');
const elLibrary     = $('library');

/* ===== LAZY THUMBNAIL OBSERVER ===== */
let thumbObserver = null;
function initThumbObserver() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      thumbObserver.unobserve(el);
      const fp = el.dataset.src;
      if (!fp) continue;
      loadArt(fp).then(url => {
        if (!url) return;
        const img = el.querySelector('img[data-lazy]');
        if (img) { img.src = url; img.style.display = 'block'; img.removeAttribute('data-lazy'); }
      });
    }
  }, { rootMargin: '200px 0px' });
}

async function loadArt(fp) {
  if (!fp) return null;
  if (artCache.has(fp)) return artCache.get(fp);
  const url = await window.musicAPI.getCoverArt(fp);
  artCache.set(fp, url || null);
  return url || null;
}

/* ===== UTILITIES ===== */
function fmt(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

/* ===== GROUPING ===== */
const inLib = t => !t.online || t.inLibrary;      // shown in the local library?
const albumArtistOf = t => t.albumArtist || t.artist;  // group by album artist, not track artist

function groupByAlbum() {
  const map = new Map();
  tracks.forEach((t,i) => {
    if (!inLib(t)) return;
    const aa = albumArtistOf(t);
    const key = `${t.album}|||${aa}`;
    if (!map.has(key)) map.set(key, { album: t.album, artist: aa, tracks: [], artFile: t.path, online: t.online });
    map.get(key).tracks.push(i);
  });
  return [...map.values()];
}
function groupByArtist() {
  const map = new Map();
  tracks.forEach((t,i) => {
    if (!inLib(t)) return;
    const aa = albumArtistOf(t);
    if (!map.has(aa)) map.set(aa, { artist: aa, tracks: [], artFile: t.path, online: t.online });
    map.get(aa).tracks.push(i);
  });
  return [...map.values()];
}
function allTracks() { return tracks.map((_,i)=>i).filter(i => inLib(tracks[i])); }

/* ===== GRID SIZE ===== */
let gridSize = 170;
$('grid-size-slider').addEventListener('input', e => {
  gridSize = parseInt(e.target.value);
  document.documentElement.style.setProperty('--grid-size', gridSize + 'px');
  document.querySelectorAll('.grid-view').forEach(g => g.style.setProperty('--grid-size', gridSize + 'px'));
  savePrefs();
});

/* ===== TABS ===== */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    libFilter = '';
    cfFilter = '';
    closeDetailPanel();
    closeInlineDetail();
    renderLibrary();
    const showCf = currentTab === 'albums' || currentTab === 'artists';
    $('cf-toggle-btn').style.display = showCf ? '' : 'none';
    if (!showCf && cfMode) { cfMode = false; $('cf-toggle-btn').classList.remove('active'); }
  });
});

/* ===== OPEN FOLDER ===== */
$('btn-open-folder').addEventListener('click', async () => {
  const fp = await window.musicAPI.openFolder();
  if (!fp) return;
  const localFiles = await window.musicAPI.readMusicFiles(fp);
  lastFolderPath = fp;
  // Replace local tracks, but KEEP the added streaming library.
  tracks = localFiles;
  artCache.clear();
  onlineIndex.clear();
  loadLibrary();                 // re-ingest persisted streaming items into the new tracks[]
  // Explore caches held indices into the previous tracks[] — reset them.
  exploreHome = null;
  searchResults = { tracks: [], albums: [], artists: [] };
  searchState = 'idle';
  exploreView = 'browse';
  exploreDetail = null;
  currentIndex = -1;
  closeDetailPanel();
  closeInlineDetail();
  initThumbObserver();
  renderLibrary();
  savePrefs();
});

/* ===== RENDER LIBRARY ===== */
const FILTER_PLACEHOLDER = { artists: 'Filtrar artistas…', albums: 'Filtrar álbumes…', songs: 'Filtrar canciones…', favorites: 'Filtrar favoritos…' };

function renderLibrary() {
  if (currentTab === 'search') { renderExplore(); return; }
  if (cfMode && currentTab === 'albums') { renderCoverFlow(); return; }
  elTrackList.innerHTML = '';
  if (!tracks.some(inLib)) {
    elTrackList.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg><p>Abre una carpeta o añade música desde Explorar</p></div>';
    return;
  }
  const wrap = el('div', 'lib-wrap');
  wrap.innerHTML = `
    <div class="lib-filter-bar">
      <span class="lib-filter-icon">${SEARCH_ICON}</span>
      <input type="text" id="lib-filter-input" placeholder="${FILTER_PLACEHOLDER[currentTab] || 'Filtrar…'}" autocomplete="off" spellcheck="false">
      <button id="lib-filter-clear" title="Limpiar" style="${libFilter ? '' : 'display:none'}">✕</button>
    </div>
    <div class="lib-results"></div>`;
  elTrackList.appendChild(wrap);

  const input = wrap.querySelector('#lib-filter-input');
  const clearBtn = wrap.querySelector('#lib-filter-clear');
  const results = wrap.querySelector('.lib-results');
  input.value = libFilter;
  input.addEventListener('input', () => {
    libFilter = input.value;
    clearBtn.style.display = libFilter ? '' : 'none';
    renderLibResults(results);
  });
  clearBtn.addEventListener('click', () => {
    libFilter = '';
    input.value = '';
    clearBtn.style.display = 'none';
    renderLibResults(results);
    input.focus();
  });
  renderLibResults(results);
}

function renderLibResults(container) {
  container.innerHTML = '';
  let count = 0;
  if (currentTab === 'albums')         { const g = applyGroupFilter(groupByAlbum(), 'album'); count = g.length; renderGrid(g, 'album', container); }
  else if (currentTab === 'artists')   { const g = applyGroupFilter(groupByArtist(), 'artist'); count = g.length; renderGrid(g, 'artist', container); }
  else if (currentTab === 'songs')     { count = renderSongsTab(container); }
  else if (currentTab === 'favorites') { count = renderFavoritesTab(container); }
  if (libFilter.trim() && !count) {
    container.innerHTML = `<div class="search-msg"><p>Sin resultados para “${esc(libFilter)}”.</p></div>`;
  }
}

function applyGroupFilter(groups, type) {
  const q = libFilter.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter(g => (type === 'artist' ? g.artist : `${g.album} ${g.artist}`).toLowerCase().includes(q));
}

function applyTrackFilter(idxs) {
  const q = libFilter.trim().toLowerCase();
  if (!q) return idxs;
  return idxs.filter(i => { const t = tracks[i]; return `${t.name} ${t.artist} ${t.album}`.toLowerCase().includes(q); });
}

function renderGrid(groups, type, container) {
  const wrap = el('div','grid-view');
  wrap.style.setProperty('--grid-size', gridSize + 'px');

  // For artist cards: precompute albums per artist for the accordion
  let albumsByArtist = null;
  if (type === 'artist') {
    albumsByArtist = new Map();
    groupByAlbum().forEach(ag => {
      if (!albumsByArtist.has(ag.artist)) albumsByArtist.set(ag.artist, []);
      albumsByArtist.get(ag.artist).push(ag);
    });
  }

  groups.forEach((g, i) => {
    const isArtist = type === 'artist';
    const card = el('div', isArtist ? 'grid-card artist-card' : 'grid-card');
    card.style.setProperty('--i', i);
    card.dataset.key  = type === 'album' ? `${g.album}|||${g.artist}` : g.artist;
    card.dataset.type = type;
    const label = type === 'album' ? g.album : g.artist;

    // Sub-text: album count for artists, artist name for albums
    let sub;
    if (isArtist) {
      const n = (albumsByArtist?.get(g.artist) || []).length;
      sub = `${n} álbum${n !== 1 ? 'es' : ''}`;
    } else {
      sub = g.artist;
    }

    const albumFaved = g.tracks.length > 0 && g.tracks.every(ti => favorites.has(tracks[ti]?.path));

    // Placeholder: person icon for artists, music note for albums
    const placeholderSvg = isArtist
      ? `<svg viewBox="0 0 24 24" fill="var(--text3)"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="var(--text3)"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

    // Album-stack cards for artist cards (fan out from behind the main card on hover)
    let stackHtml = '';
    if (isArtist && albumsByArtist) {
      const artistAlbums = albumsByArtist.get(g.artist) || [];
      const stackAlbums = artistAlbums.slice(0, 3); // up to 3 cards in the stack
      if (stackAlbums.length > 0) {
        // Assign si=0 (front) to album[0], si=1 to album[1], si=2 to album[2].
        // Render in REVERSE order so si=0 is last in DOM → painted on top.
        const items = stackAlbums.map((ag, idx) =>
          `<div class="stack-album" style="--si:${idx}" data-src="${ag.artFile}" data-album="${ag.album.replace(/"/g,'&quot;')}" data-artist="${ag.artist.replace(/"/g,'&quot;')}">
            <img data-lazy="1" src="" alt="" style="display:none">
          </div>`
        ).reverse().join('');
        stackHtml = `<div class="artist-stack">${items}</div>`;
      }
    }

    // For artist cards: no data-src on the main art — keeps the person placeholder visible
    const artDataSrc = isArtist ? '' : ` data-src="${g.artFile}"`;

    card.innerHTML = `
      ${stackHtml}
      <div class="grid-card-art"${artDataSrc}>
        <div class="placeholder-icon">${placeholderSvg}</div>
        ${isArtist ? '' : `<img data-lazy="1" src="" alt="" style="display:none" onerror="this.style.display='none'">`}
        <div class="play-overlay"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      </div>
      <div class="grid-card-info">
        <div class="grid-card-title" title="${label}">${label}</div>
        <div class="grid-card-sub">
          <span class="grid-card-sub-text">${sub}</span>
          <button class="grid-card-fav${albumFaved ? ' on' : ''}" title="${albumFaved ? 'Quitar de favoritos' : 'Añadir a favoritos'}">♥</button>
        </div>
      </div>
      ${g.online ? srcBadge(true) : ''}`;

    // Observe art only for album cards (artist cards keep the person placeholder)
    if (!isArtist) thumbObserver && thumbObserver.observe(card.querySelector('.grid-card-art'));

    // Observe stack album thumbnails + wire click to open album detail
    if (isArtist) {
      const artistAlbums = albumsByArtist?.get(g.artist) || [];
      card.querySelectorAll('.stack-album').forEach(stackEl => {
        thumbObserver && thumbObserver.observe(stackEl);
        stackEl.addEventListener('click', e => {
          e.stopPropagation();
          openAlbumDetail(stackEl.dataset.album, stackEl.dataset.artist);
        });
      });
    }

    // Play icon SVG click → play immediately (stopPropagation prevents card click)
    card.querySelector('.play-overlay svg').addEventListener('click', e => {
      e.stopPropagation();
      clearTimeout(clickTimers.get(card.dataset.key));
      clickTimers.delete(card.dataset.key);
      playGroup(type, g);
    });

    // Favorite button for the whole album/artist group
    card.querySelector('.grid-card-fav').addEventListener('click', e => {
      e.stopPropagation();
      const fav = card.querySelector('.grid-card-fav');
      const on = g.tracks.every(ti => favorites.has(tracks[ti]?.path));
      g.tracks.forEach(ti => {
        if (tracks[ti]) { on ? favorites.delete(tracks[ti].path) : favorites.add(tracks[ti].path); }
      });
      fav.classList.toggle('on', !on);
      fav.title = !on ? 'Quitar de favoritos' : 'Añadir a favoritos';
      savePrefs();
    });

    // Single click → open detail; double click → play
    card.addEventListener('click', () => {
      const key = card.dataset.key;
      const timer = clickTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        clickTimers.delete(key);
        playGroup(type, g);
        return;
      }
      clickTimers.set(key, setTimeout(() => {
        clickTimers.delete(key);
        if (detailPosMode === 'inline') {
          openInlineDetail(card, type, g);
        } else if (type === 'album') {
          openAlbumDetail(g.album, g.artist);
        } else {
          openArtistDetail(g.artist);
        }
      }, 260));
    });
    wrap.appendChild(card);
  });
  container.appendChild(wrap);
}

function renderSongsTab(container) {
  const idxs = applyTrackFilter(allTracks());
  const wrap = el('div','list-view');
  idxs.forEach((ti, i) => {
    const row = buildTrackRow(tracks[ti], ti, i, true);
    row.addEventListener('click', () => playTrack(ti, idxs, 'album'));
    wrap.appendChild(row);
  });
  container.appendChild(wrap);
  return idxs.length;
}

function renderFavoritesTab(container) {
  // Controls bar
  const bar = el('div', 'fav-controls');
  bar.innerHTML = `
    <div class="fav-ctrl-group">
      <span class="fav-ctrl-label">Mínimo</span>
      ${[0,1,2,3,4,5].map(n => `<button class="fav-star-btn${favMinStars===n?' active':''}" data-min="${n}">${n===0?'Todos':'★'.repeat(n)}</button>`).join('')}
    </div>
    <div class="fav-ctrl-group">
      <button class="fav-sort-btn${favSortBy==='default'?' active':''}" data-sort="default">Por defecto</button>
      <button class="fav-sort-btn${favSortBy==='rating'?' active':''}" data-sort="rating">Mejor puntuadas</button>
    </div>`;
  bar.querySelectorAll('.fav-star-btn').forEach(b => b.addEventListener('click', () => {
    favMinStars = parseInt(b.dataset.min);
    bar.querySelectorAll('.fav-star-btn').forEach(x => x.classList.toggle('active', x === b));
    container.querySelector('.fav-list-wrap')?.remove();
    renderFavList(container);
    savePrefs();
  }));
  bar.querySelectorAll('.fav-sort-btn').forEach(b => b.addEventListener('click', () => {
    favSortBy = b.dataset.sort;
    bar.querySelectorAll('.fav-sort-btn').forEach(x => x.classList.toggle('active', x === b));
    container.querySelector('.fav-list-wrap')?.remove();
    renderFavList(container);
    savePrefs();
  }));
  container.appendChild(bar);
  renderFavList(container);
  // return count is approximated
  return tracks.filter((t,i) => (favorites.has(t.path) || (ratings[t.path]||0) >= favMinStars && favMinStars > 0)).length;
}

function renderFavList(container) {
  container.querySelector('.fav-list-wrap')?.remove();
  let idxs = tracks.map((_,i)=>i).filter(i => {
    const t = tracks[i];
    const isFav = favorites.has(t.path);
    const starOk = favMinStars === 0 ? isFav : (ratings[t.path] || 0) >= favMinStars;
    return isFav || (favMinStars > 0 && starOk);
  });
  idxs = applyTrackFilter(idxs);
  if (favSortBy === 'rating') idxs = [...idxs].sort((a,b) => (ratings[tracks[b].path]||0) - (ratings[tracks[a].path]||0));
  const wrap = el('div','list-view fav-list-wrap');
  idxs.forEach((ti, i) => {
    const row = buildTrackRow(tracks[ti], ti, i, true);
    row.addEventListener('click', () => playTrack(ti, idxs, 'album'));
    wrap.appendChild(row);
  });
  container.appendChild(wrap);
}

/* ===== EXPLORE (online: YouTube + Audius) ===== */
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const NOTE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
const PERSON_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
const esc = s => (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const msgLoading = txt => `<div class="search-msg"><div class="search-spinner"></div><p>${esc(txt)}</p></div>`;
const MSG_ERROR = '<div class="search-msg"><p>No se pudo conectar. Revisa tu conexión a internet e inténtalo de nuevo.</p></div>';

/* Add an online track (Deezer metadata or direct YouTube) to tracks[] and return its index. */
function ingestTrack(r) {
  const source = r.source || 'deezer';
  const path = source + ':' + r.id;
  if (r.artUrl) artCache.set(path, r.artUrl);
  if (onlineIndex.has(path)) return onlineIndex.get(path);
  tracks.push({
    name: r.title, artist: r.artist, album: r.album || r.artist,
    albumArtist: r.albumArtist || r.artist, genre: r.genre || '',
    artistId: r.artistId || null, online: true, source, path, inLibrary: false,
    videoId: source === 'youtube' ? r.id : null,
    query: r.query || (r.artist ? `${r.artist} ${r.title}` : r.title),
    stream: r.stream || null, duration: r.duration || 0,
  });
  const idx = tracks.length - 1;
  onlineIndex.set(path, idx);
  return idx;
}

/* ---- source badge (local vs streaming) shown on cover art ---- */
const SRC_ICON_ONLINE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>';
const SRC_ICON_LOCAL = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16c1.1 0 2 .9 2 2v9c0 1.1-.9 2-2 2h-6v2h2v2H8v-2h2v-2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/></svg>';
const srcBadge = isOnline => `<div class="src-badge ${isOnline ? 'online' : 'local'}" title="${isOnline ? 'Streaming' : 'Archivo local'}">${isOnline ? SRC_ICON_ONLINE : SRC_ICON_LOCAL}</div>`;

/* ---- library membership (added online items persist like local files) ---- */
const LIB_KEY = 'zen-library-v1';
function saveLibrary() {
  try {
    const items = tracks.filter(t => t.online && t.inLibrary).map(t => ({
      source: t.source,
      id: t.path.slice(t.source.length + 1),
      title: t.name, artist: t.artist, album: t.album, albumArtist: t.albumArtist,
      artUrl: artCache.get(t.path) || '',
      duration: t.duration, query: t.query, videoId: t.videoId,
    }));
    localStorage.setItem(LIB_KEY, JSON.stringify(items));
  } catch { /* ignore */ }
}
function loadLibrary() {
  try {
    const items = JSON.parse(localStorage.getItem(LIB_KEY) || '[]');
    const idxs = items.map(r => { const idx = ingestTrack(r); tracks[idx].inLibrary = true; return idx; });
    migrateAlbumArtists(idxs);
  } catch { /* ignore */ }
}

/* Fix libraries saved before album-artist grouping: if an album's tracks have
   mixed album-artists (collabs kept their own name), use the dominant one. */
function migrateAlbumArtists(idxs) {
  const byAlbum = new Map();
  idxs.forEach(i => {
    const t = tracks[i]; if (!t) return;
    if (!byAlbum.has(t.album)) byAlbum.set(t.album, []);
    byAlbum.get(t.album).push(i);
  });
  let changed = false;
  byAlbum.forEach(group => {
    if (new Set(group.map(i => tracks[i].albumArtist)).size <= 1) return; // consistent
    const counts = {};
    group.forEach(i => { const a = tracks[i].artist; counts[a] = (counts[a] || 0) + 1; });
    let dominant = null, max = 0;
    for (const a in counts) if (counts[a] > max) { max = counts[a]; dominant = a; }
    if (dominant) { group.forEach(i => { tracks[i].albumArtist = dominant; }); changed = true; }
  });
  if (changed) saveLibrary();
}
function setTrackInLibrary(idx, on) {
  if (tracks[idx]) tracks[idx].inLibrary = on;
}
function addTracksToLibrary(idxs) {
  idxs.forEach(i => setTrackInLibrary(i, true));
  saveLibrary();
}
function tracksAllInLibrary(idxs) {
  return idxs.length > 0 && idxs.every(i => tracks[i] && tracks[i].inLibrary);
}

const PLUS_ICON  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';

/* Small +/✓ button to add or remove a single online track from the library. */
function addLibBtnToRow(row, ti) {
  if (!tracks[ti].online) return; // local tracks are already in the library
  const btn = el('button', 'add-lib-btn' + (tracks[ti].inLibrary ? ' added' : ''));
  const paint = () => {
    const on = !!tracks[ti].inLibrary;
    btn.classList.toggle('added', on);
    btn.innerHTML = on ? CHECK_ICON : PLUS_ICON;
    btn.title = on ? 'En tu biblioteca (clic para quitar)' : 'Añadir a mi biblioteca';
  };
  paint();
  btn.addEventListener('click', e => {
    e.stopPropagation();
    setTrackInLibrary(ti, !tracks[ti].inLibrary);
    saveLibrary();
    paint();
  });
  row.insertBefore(btn, row.querySelector('.track-star-row'));
}

/* A track row for the Explore views: art + source badge + add-to-library button. */
function exploreTrackRow(ti, i, queueIdxs) {
  const row = buildTrackRow(tracks[ti], ti, i, true);
  addLibBtnToRow(row, ti);
  row.addEventListener('click', () => playTrack(ti, queueIdxs, 'album'));
  return row;
}

async function doSearch(q) {
  q = (q || '').trim();
  searchQuery = q;
  exploreView = 'browse';
  if (!q) { searchState = 'idle'; searchResults = { tracks: [], albums: [], artists: [] }; renderExplore(); return; }
  searchState = 'loading';
  renderExplore();
  let data = null;
  try { data = await window.musicAPI.searchOnline(q); } catch { data = null; }
  if (!data) { searchState = 'error'; renderExplore(); return; }
  searchResults = {
    tracks: (data.tracks || []).map(ingestTrack),
    albums: data.albums || [],
    artists: data.artists || [],
  };
  searchState = 'done';
  renderExplore();
}

function renderExplore() {
  elTrackList.innerHTML = '';
  const wrap = el('div', 'search-tab');
  wrap.innerHTML = `
    <div class="search-bar">
      <span class="search-icon">${SEARCH_ICON}</span>
      <input type="text" id="search-input" placeholder="Buscar canciones, álbumes, artistas..." autocomplete="off" spellcheck="false">
      <button id="search-go">Buscar</button>
      ${searchQuery ? '<button id="search-clear" title="Limpiar búsqueda">✕</button>' : ''}
    </div>
    <div class="explore-body"></div>`;
  elTrackList.appendChild(wrap);

  const input = wrap.querySelector('#search-input');
  input.value = searchQuery;
  const go = () => doSearch(input.value);
  wrap.querySelector('#search-go').addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const clr = wrap.querySelector('#search-clear');
  if (clr) clr.addEventListener('click', () => { searchQuery = ''; searchState = 'idle'; exploreView = 'browse'; renderExplore(); });
  if (searchState !== 'loading' && exploreView === 'browse') {
    setTimeout(() => { input.focus(); input.selectionStart = input.value.length; }, 30);
  }

  const body = wrap.querySelector('.explore-body');
  if (exploreView === 'album' || exploreView === 'artist') { renderExploreDetail(body); return; }
  if (searchState === 'loading') { body.innerHTML = msgLoading('Buscando…'); return; }
  if (searchState === 'error')   { body.innerHTML = MSG_ERROR; return; }
  if (searchState === 'done')    { renderSearchResults(body); return; }
  renderExploreHome(body); // idle
}

async function renderExploreHome(body) {
  if (!exploreHome) {
    body.innerHTML = msgLoading('Cargando lo más popular…');
    let data = null;
    try { data = await window.musicAPI.exploreHome(); } catch { data = null; }
    if (!data) { body.innerHTML = MSG_ERROR; return; }
    exploreHome = {
      tracks: (data.tracks || []).map(ingestTrack),
      albums: data.albums || [],
      artists: data.artists || [],
    };
    if (currentTab === 'search' && exploreView === 'browse' && searchState === 'idle') renderExplore();
    return;
  }
  body.innerHTML = '';
  if (exploreHome.artists.length) body.appendChild(sectionArtists('Artistas populares', exploreHome.artists));
  if (exploreHome.albums.length)  body.appendChild(sectionAlbums('Álbumes populares', exploreHome.albums));
  if (exploreHome.tracks.length)  body.appendChild(sectionTracks('Canciones populares', exploreHome.tracks));
}

function renderSearchResults(body) {
  body.innerHTML = '';
  const r = searchResults;
  if (!r.tracks.length && !r.albums.length && !r.artists.length) {
    body.innerHTML = `<div class="search-msg"><p>Sin resultados para “${esc(searchQuery)}”.</p></div>`;
    return;
  }
  if (r.artists.length) body.appendChild(sectionArtists('Artistas', r.artists.slice(0, 12)));
  if (r.albums.length)  body.appendChild(sectionAlbums('Álbumes', r.albums.slice(0, 12)));
  if (r.tracks.length)  body.appendChild(sectionTracks('Canciones', r.tracks));
}

/* ---- section builders ---- */
function sectionTracks(title, trackIdxs) {
  const sec = el('div', 'ex-section');
  sec.appendChild(el('div', 'ex-section-title', esc(title)));
  const lw = el('div', 'list-view');
  trackIdxs.forEach((ti, i) => lw.appendChild(exploreTrackRow(ti, i, trackIdxs)));
  sec.appendChild(lw);
  return sec;
}

function sectionAlbums(title, albums) {
  const sec = el('div', 'ex-section');
  sec.appendChild(el('div', 'ex-section-title', esc(title)));
  const grid = el('div', 'ex-grid');
  albums.forEach(a => {
    const card = el('div', 'ex-card');
    card.innerHTML = `
      <div class="ex-card-art">
        ${a.artUrl ? `<img src="${esc(a.artUrl)}" alt="" onerror="this.style.display='none'">` : `<div class="ex-placeholder">${NOTE_ICON}</div>`}
        <div class="ex-play-badge">${PLAY_ICON}</div>
      </div>
      <div class="ex-card-title" title="${esc(a.name)}">${esc(a.name)}</div>
      <div class="ex-card-sub">${esc(a.artist || 'Álbum')}</div>`;
    card.addEventListener('click', () => openOnlineAlbum(a));
    grid.appendChild(card);
  });
  sec.appendChild(grid);
  return sec;
}

function sectionArtists(title, artists) {
  const sec = el('div', 'ex-section');
  sec.appendChild(el('div', 'ex-section-title', esc(title)));
  const grid = el('div', 'ex-artist-grid');
  artists.forEach(a => {
    const card = el('div', 'ex-card');
    card.innerHTML = `
      <div class="ex-card-art round">
        ${a.artUrl ? `<img src="${esc(a.artUrl)}" alt="" onerror="this.style.display='none'">` : `<div class="ex-placeholder">${PERSON_ICON}</div>`}
      </div>
      <div class="ex-card-title" title="${esc(a.name)}">${esc(a.name)}</div>
      <div class="ex-card-sub">Artista</div>`;
    card.addEventListener('click', () => openOnlineArtist(a));
    grid.appendChild(card);
  });
  sec.appendChild(grid);
  return sec;
}

/* ---- drill-down ---- */
async function openOnlineAlbum(album) {
  exploreView = 'album';
  exploreDetail = { type: 'album', id: album.id, name: album.name, sub: album.artist, artUrl: album.artUrl, trackIdxs: null };
  renderExplore();
  let data = null;
  try { data = await window.musicAPI.getAlbumTracks(album.id); } catch { data = null; }
  if (!(exploreView === 'album' && exploreDetail && exploreDetail.id === album.id)) return;
  exploreDetail.trackIdxs = (data || []).map(ingestTrack);
  renderExplore();
}

async function openOnlineArtist(artist) {
  exploreView = 'artist';
  exploreDetail = { type: 'artist', id: artist.id, name: artist.name, sub: 'Artista', artUrl: artist.artUrl, trackIdxs: null, albums: null };
  renderExplore();
  let topTracks = null, albums = null;
  try {
    [topTracks, albums] = await Promise.all([
      window.musicAPI.getArtistTracks(artist.id),
      window.musicAPI.getArtistAlbums(artist.id),
    ]);
  } catch { topTracks = null; albums = null; }
  if (!(exploreView === 'artist' && exploreDetail && exploreDetail.id === artist.id)) return;
  exploreDetail.trackIdxs = (topTracks || []).map(ingestTrack);
  exploreDetail.albums = albums || [];
  renderExplore();
}

function renderExploreDetail(body) {
  const d = exploreDetail;
  body.innerHTML = '';
  const back = el('button', 'ex-back', '‹ Volver');
  back.addEventListener('click', () => { exploreView = 'browse'; renderExplore(); });
  body.appendChild(back);

  const head = el('div', 'ex-detail-head');
  head.innerHTML = `
    <div class="ex-detail-art ${d.type === 'artist' ? 'round' : ''}">
      ${d.artUrl ? `<img src="${esc(d.artUrl)}" alt="" onerror="this.style.display='none'">` : `<div class="ex-placeholder">${d.type === 'artist' ? PERSON_ICON : NOTE_ICON}</div>`}
    </div>
    <div class="ex-detail-meta">
      <span class="ex-detail-type">${d.type === 'album' ? 'ÁLBUM' : 'ARTISTA'}</span>
      <h2>${esc(d.name)}</h2>
      <p>${esc(d.sub || '')}</p>
      <div class="ex-detail-actions">
        <button class="ex-detail-play">${PLAY_ICON} Reproducir</button>
        <button class="ex-detail-add"></button>
      </div>
    </div>`;
  body.appendChild(head);
  head.querySelector('.ex-detail-play').addEventListener('click', () => {
    if (d.trackIdxs && d.trackIdxs.length) playTrack(d.trackIdxs[0], d.trackIdxs, 'album');
  });
  const addBtn = head.querySelector('.ex-detail-add');
  const label = d.type === 'album' ? 'álbum' : 'artista';
  const paintAdd = () => {
    const idxs = d.trackIdxs || [];
    const all = tracksAllInLibrary(idxs);
    addBtn.disabled = !idxs.length;
    addBtn.classList.toggle('added', all);
    addBtn.innerHTML = all ? `${CHECK_ICON} En biblioteca` : `${PLUS_ICON} Añadir ${label}`;
  };
  addBtn.addEventListener('click', () => {
    const idxs = d.trackIdxs || [];
    if (!idxs.length) return;
    const all = tracksAllInLibrary(idxs);
    idxs.forEach(i => setTrackInLibrary(i, !all));
    saveLibrary();
    paintAdd();
  });
  paintAdd();

  // Artist: show their albums first.
  if (d.type === 'artist' && d.albums && d.albums.length) {
    body.appendChild(sectionAlbums('Álbumes', d.albums));
  }

  const listCont = el('div', 'ex-section');
  body.appendChild(listCont);
  listCont.appendChild(el('div', 'ex-section-title', d.type === 'artist' ? 'Canciones populares' : 'Canciones'));

  if (d.trackIdxs === null) {
    const m = el('div', ''); m.innerHTML = msgLoading('Cargando canciones…'); listCont.appendChild(m); return;
  }
  if (!d.trackIdxs.length) {
    const m = el('div', ''); m.innerHTML = '<div class="search-msg"><p>No hay canciones disponibles.</p></div>'; listCont.appendChild(m); return;
  }
  const lw = el('div', 'list-view');
  d.trackIdxs.forEach((ti, i) => lw.appendChild(exploreTrackRow(ti, i, d.trackIdxs)));
  listCont.appendChild(lw);
}

/* ===== INLINE DETAIL (MusicBee style) ===== */
function openInlineDetail(clickedCard, type, group) {
  closeInlineDetail();
  const grid = clickedCard.closest('.grid-view');
  if (!grid) return;
  const insertAfter = getLastCardInRow(clickedCard, grid);
  const panel = el('div','inline-detail');
  if (type === 'album') {
    buildInlineAlbum(panel, group);
  } else {
    buildInlineArtist(panel, group);
  }
  insertAfter.insertAdjacentElement('afterend', panel);
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  document.querySelectorAll('.grid-card.selected').forEach(c => c.classList.remove('selected'));
  clickedCard.classList.add('selected');
}

function getLastCardInRow(clickedCard, grid) {
  const clickedTop = clickedCard.getBoundingClientRect().top;
  const cards = [...grid.querySelectorAll('.grid-card')];
  let last = clickedCard;
  for (const c of cards) {
    if (Math.abs(c.getBoundingClientRect().top - clickedTop) < 10) last = c;
  }
  return last;
}

function closeInlineDetail() {
  document.querySelectorAll('.inline-detail').forEach(p => p.remove());
  document.querySelectorAll('.grid-card.selected').forEach(c => c.classList.remove('selected'));
}

function buildInlineAlbum(panel, group) {
  const { tracks: trackIdxs, album: albumName, artist: artistName } = group;
  panel.innerHTML = `
    <div class="id-inner">
      <div class="id-art-col">
        <img src="" alt="" style="display:none" onerror="this.style.display='none'">
        <div class="id-art-gradient"></div>
        ${srcBadge(!!group.online)}
        <button class="id-art-play-btn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Reproducir</button>
      </div>
      <div class="id-content">
        <div class="id-header">
          <div class="id-header-info"><h2>${albumName}</h2><p>${artistName} · ${trackIdxs.length} canciones</p></div>
          <div class="id-header-actions">${buildViewModeBtns()}<button class="id-close-btn" title="Cerrar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div>
        </div>
        <div class="id-tracks"></div>
      </div>
    </div>`;
  loadArt(tracks[trackIdxs[0]]?.path).then(url => {
    if (!url) return;
    const img = panel.querySelector('.id-art-col img');
    img.src = url; img.style.display = 'block';
  });
  panel.querySelector('.id-art-play-btn').addEventListener('click', () => playTrack(trackIdxs[0], trackIdxs, 'album'));
  panel.querySelector('.id-close-btn').addEventListener('click', closeInlineDetail);
  wireViewModes(panel, () => renderInlineTracks(panel.querySelector('.id-tracks'), trackIdxs));
  renderInlineTracks(panel.querySelector('.id-tracks'), trackIdxs);
}

function buildInlineArtist(panel, group) {
  const artistTracks = group.tracks;
  const albumMap = {};
  artistTracks.forEach(ti => {
    const t = tracks[ti];
    if (!albumMap[t.album]) albumMap[t.album] = { album: t.album, artist: t.artist, tracks: [], artFile: t.path };
    albumMap[t.album].tracks.push(ti);
  });
  const albumList = Object.values(albumMap);
  let activeAlbum = albumList[0];

  panel.innerHTML = `
    <div class="id-inner">
      <div class="id-art-col">
        <img src="" alt="" style="display:none" onerror="this.style.display='none'">
        <div class="id-art-gradient"></div>
        ${srcBadge(!!group.online)}
        <button class="id-art-play-btn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Reproducir todo</button>
      </div>
      <div class="id-content">
        <div class="id-header">
          <div class="id-header-info"><h2>${group.artist}</h2><p>${artistTracks.length} canciones · ${albumList.length} álbumes</p></div>
          <div class="id-header-actions">${buildViewModeBtns()}<button class="id-close-btn" title="Cerrar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button></div>
        </div>
        <div class="id-albums-row"></div>
        <div class="id-tracks"></div>
      </div>
    </div>`;

  const albumsRow = panel.querySelector('.id-albums-row');
  const artImg    = panel.querySelector('.id-art-col img');

  function switchAlbum(alb) {
    activeAlbum = alb;
    albumsRow.querySelectorAll('.id-album-chip').forEach(c => c.classList.toggle('active', c.dataset.album === alb.album));
    loadArt(alb.artFile).then(url => { if (url) { artImg.src = url; artImg.style.display = 'block'; } else artImg.style.display = 'none'; });
    renderInlineTracks(panel.querySelector('.id-tracks'), alb.tracks);
  }

  albumList.forEach(alb => {
    const chip = el('button','id-album-chip');
    chip.textContent = alb.album;
    chip.dataset.album = alb.album;
    chip.classList.toggle('active', alb === activeAlbum);
    chip.addEventListener('click', () => switchAlbum(alb));
    albumsRow.appendChild(chip);
  });

  loadArt(activeAlbum.artFile).then(url => { if (url) { artImg.src = url; artImg.style.display = 'block'; } });
  panel.querySelector('.id-art-play-btn').addEventListener('click', () => playTrack(artistTracks[0], artistTracks, 'artist'));
  panel.querySelector('.id-close-btn').addEventListener('click', closeInlineDetail);
  wireViewModes(panel, () => renderInlineTracks(panel.querySelector('.id-tracks'), activeAlbum.tracks));
  renderInlineTracks(panel.querySelector('.id-tracks'), activeAlbum.tracks);
}

function buildViewModeBtns() {
  const modes = [
    { k:'list',    svg:'<path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>',  title:'Lista' },
    { k:'columns', svg:'<path d="M3 5v14h8V5H3zm6 12H5v-2h4v2zm0-4H5v-2h4v2zm0-4H5V7h4v2zm6-4v14h8V5h-8zm6 12h-4v-2h4v2zm0-4h-4v-2h4v2zm0-4h-4V7h4v2z"/>', title:'Columnas' },
    { k:'table',   svg:'<path d="M20 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 2v3H5V5h15zm-9 14H5v-9h6v9zm9 0h-7v-9h7v9z"/>',  title:'Tabla' },
    { k:'compact', svg:'<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>',             title:'Compacta' },
  ];
  return modes.map(m => `<button class="dm-btn${m.k===detailViewMode?' active':''}" data-view="${m.k}" title="${m.title}"><svg viewBox="0 0 24 24" fill="currentColor">${m.svg}</svg></button>`).join('');
}

function wireViewModes(panel, refreshFn) {
  panel.querySelectorAll('.dm-btn').forEach(b => {
    b.addEventListener('click', () => {
      detailViewMode = b.dataset.view;
      panel.querySelectorAll('.dm-btn').forEach(x => x.classList.toggle('active', x.dataset.view === detailViewMode));
      refreshFn();
      syncViewModeButtons();
      savePrefs();
    });
  });
}

function renderInlineTracks(container, trackIdxs) {
  container.innerHTML = '';
  if (detailViewMode === 'table') {
    container.appendChild(buildTableView(trackIdxs));
  } else if (detailViewMode === 'columns') {
    const w = el('div','columns-view');
    trackIdxs.forEach((ti, i) => { const r = buildTrackRow(tracks[ti], ti, i, false); r.addEventListener('click', () => playTrack(ti, trackIdxs, 'album')); w.appendChild(r); });
    container.appendChild(w);
  } else if (detailViewMode === 'compact') {
    const w = el('div','compact-view');
    trackIdxs.forEach((ti, i) => { const r = buildCompactRow(tracks[ti], ti, i); r.addEventListener('click', () => playTrack(ti, trackIdxs, 'album')); w.appendChild(r); });
    container.appendChild(w);
  } else {
    const w = el('div','list-view');
    trackIdxs.forEach((ti, i) => { const r = buildTrackRow(tracks[ti], ti, i, false); r.addEventListener('click', () => playTrack(ti, trackIdxs, 'album')); w.appendChild(r); });
    container.appendChild(w);
  }
}

/* ===== BOTTOM / RIGHT DETAIL PANEL ===== */
function openAlbumDetail(albumName, artistName) {
  const g = groupByAlbum().find(a => a.album === albumName && a.artist === artistName);
  if (!g) return;
  detailOpenKey = `${albumName}|||${artistName}`;
  detailOpenType = 'album';
  detailAlbumFilter = albumName;
  elDetailTitle.textContent = albumName;
  renderDetailAlbumList([g], g);
  renderDetailSongs(g.tracks);
  showDetailPanel();
}

function openArtistDetail(artistName) {
  const artistAlbs = groupByAlbum().filter(a => a.artist === artistName);
  if (!artistAlbs.length) return;
  detailOpenKey   = artistName;
  detailOpenType  = 'artist';
  detailAlbumFilter = artistAlbs[0].album;
  elDetailTitle.textContent = artistName;
  renderDetailAlbumList(artistAlbs, artistAlbs[0]);
  renderDetailSongs(artistAlbs[0].tracks);
  showDetailPanel();
}

function renderDetailAlbumList(albumGroups, activeGroup) {
  elDetailAlbums.innerHTML = '';
  albumGroups.forEach(g => {
    const item = el('div','detail-album-item');
    item.classList.toggle('active', g === activeGroup);
    item.innerHTML = `<div class="detail-album-art"><svg viewBox="0 0 24 24" fill="var(--text3)"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div><span>${g.album}</span>`;
    loadArt(g.artFile).then(url => {
      if (!url) return;
      const artDiv = item.querySelector('.detail-album-art');
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:5px';
      artDiv.appendChild(img);
    });
    item.addEventListener('click', () => {
      elDetailAlbums.querySelectorAll('.detail-album-item').forEach(x => x.classList.remove('active'));
      item.classList.add('active');
      detailAlbumFilter = g.album;
      renderDetailSongs(g.tracks);
    });
    elDetailAlbums.appendChild(item);
  });
}

function renderDetailSongs(trackIdxs) {
  elDetailSongs.innerHTML = '';
  if (detailViewMode === 'table') {
    elDetailSongs.appendChild(buildTableView(trackIdxs));
  } else if (detailViewMode === 'columns') {
    const w = el('div','columns-view');
    trackIdxs.forEach((ti, i) => { const r = buildTrackRow(tracks[ti], ti, i, false); r.addEventListener('click', () => playTrack(ti, trackIdxs, 'album')); w.appendChild(r); });
    elDetailSongs.appendChild(w);
  } else if (detailViewMode === 'compact') {
    const w = el('div','compact-view');
    trackIdxs.forEach((ti, i) => { const r = buildCompactRow(tracks[ti], ti, i); r.addEventListener('click', () => playTrack(ti, trackIdxs, 'album')); w.appendChild(r); });
    elDetailSongs.appendChild(w);
  } else {
    const w = el('div','list-view');
    trackIdxs.forEach((ti, i) => { const r = buildTrackRow(tracks[ti], ti, i, false); r.addEventListener('click', () => playTrack(ti, trackIdxs, 'album')); w.appendChild(r); });
    elDetailSongs.appendChild(w);
  }
}

function getOpenTrackIdxs() {
  if (!detailOpenKey) return [];
  if (detailOpenType === 'album') {
    const parts = detailOpenKey.split('|||');
    const g = groupByAlbum().find(a => a.album === parts[0] && a.artist === parts[1]);
    return g ? g.tracks : [];
  } else {
    const filtered = groupByAlbum().filter(a => a.artist === detailOpenKey && (!detailAlbumFilter || a.album === detailAlbumFilter));
    return filtered.flatMap(a => a.tracks);
  }
}

function showDetailPanel() {
  if (detailPosMode === 'right') {
    elLibrary.classList.add('pos-right');
  } else {
    elLibrary.classList.remove('pos-right');
  }
  elDetailPanel.classList.add('open');
}

function closeDetailPanel() {
  elDetailPanel.classList.remove('open');
  elLibrary.classList.remove('pos-right');
  detailOpenKey = null;
  detailOpenType = null;
}

/* ===== DETAIL POSITION BUTTONS ===== */
document.querySelectorAll('.dp-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dp-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    detailPosMode = btn.dataset.pos;
    if (detailPosMode === 'inline') {
      closeDetailPanel();
    } else {
      closeInlineDetail();
      if (detailOpenKey) {
        if (detailOpenType === 'album') {
          const [alb, art] = detailOpenKey.split('|||');
          openAlbumDetail(alb, art);
        } else {
          openArtistDetail(detailOpenKey);
        }
      }
    }
    savePrefs();
  });
});

/* ===== DETAIL VIEW MODE BUTTONS ===== */
document.querySelectorAll('#detail-view-modes .dm-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    detailViewMode = btn.dataset.view;
    syncViewModeButtons();
    if (detailOpenKey) renderDetailSongs(getOpenTrackIdxs());
    savePrefs();
  });
});

function syncViewModeButtons() {
  document.querySelectorAll('#detail-view-modes .dm-btn').forEach(b => b.classList.toggle('active', b.dataset.view === detailViewMode));
}

$('detail-thumb-slider').addEventListener('input', e => {
  document.documentElement.style.setProperty('--detail-thumb-size', e.target.value + 'px');
  savePrefs();
});
$('detail-close').addEventListener('click', () => { closeDetailPanel(); closeInlineDetail(); });
$('detail-play-all').addEventListener('click', () => { const idxs = getOpenTrackIdxs(); if (idxs.length) playTrack(idxs[0], idxs, 'album'); });

/* ===== TRACK ROW BUILDERS ===== */
function thumbSize() {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--detail-thumb-size').trim() || '34');
}

function buildTrackRow(t, ti, i, showAlbum) {
  const row = el('div', `track-row${ti === currentIndex ? ' playing' : ''}`);
  row.style.setProperty('--i', i);
  row.dataset.ti = ti;
  const rating = ratings[t.path] || 0;
  const isFav  = favorites.has(t.path);
  const ts = thumbSize();
  const sublabel = t.online ? (t.artist || '') : t.album;
  row.innerHTML = `
    <span class="track-num">${i + 1}</span>
    <div class="track-thumb" style="width:${ts}px;height:${ts}px">
      <div class="thumb-placeholder"><svg viewBox="0 0 24 24" fill="var(--text3)"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>
      ${srcBadge(!!t.online)}
    </div>
    <div style="flex:1;min-width:0">
      <div class="track-name">${t.name}</div>
      ${showAlbum ? `<div class="track-album-label">${sublabel}</div>` : ''}
    </div>
    <div class="track-star-row">${[1,2,3,4,5].map(n=>`<span class="track-star${n<=rating?' on':''}" data-n="${n}">★</span>`).join('')}</div>
    <span class="track-fav${isFav?' on':''}">♥</span>`;

  loadArt(t.path).then(url => {
    if (!url) return;
    const th = row.querySelector('.track-thumb');
    if (!th) return;
    const ph = th.querySelector('.thumb-placeholder');
    if (ph) ph.remove();
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:5px;display:block';
    th.insertBefore(img, th.firstChild);
  });

  const starRow = row.querySelector('.track-star-row');
  starRow.addEventListener('mouseover', e => {
    if (!e.target.classList.contains('track-star')) return;
    const n = parseInt(e.target.dataset.n);
    // Only add .hover to stars that are NOT already rated (.on) — don't dim saved rating
    starRow.querySelectorAll('.track-star').forEach(s => {
      const inRange = parseInt(s.dataset.n) <= n;
      s.classList.toggle('hover', inRange && !s.classList.contains('on'));
    });
  });
  starRow.addEventListener('mouseleave', () => {
    starRow.querySelectorAll('.track-star').forEach(s => s.classList.remove('hover'));
  });
  starRow.querySelectorAll('.track-star').forEach(star => {
    star.addEventListener('click', e => {
      e.stopPropagation();
      setRating(t.path, parseInt(star.dataset.n));
      const newR = ratings[t.path] || 0;
      starRow.querySelectorAll('.track-star').forEach(s => {
        s.classList.toggle('on', parseInt(s.dataset.n) <= newR);
        s.classList.remove('hover');
      });
      savePrefs();
      if (ti === currentIndex) updateMbFavStars();
    });
  });
  const favEl = row.querySelector('.track-fav');
  favEl.addEventListener('click', e => {
    e.stopPropagation();
    const on = favorites.has(t.path);
    on ? favorites.delete(t.path) : favorites.add(t.path);
    favEl.classList.toggle('on', !on);
    if (!on) {
      favEl.classList.remove('pop-anim');
      void favEl.offsetWidth; // restart animation
      favEl.classList.add('pop-anim');
    }
    if (ti === currentIndex) updateMbFavStars();
    savePrefs();
  });
  return row;
}

function buildCompactRow(t, ti, i) {
  const row = el('div', `compact-row${ti === currentIndex ? ' playing' : ''}`);
  row.style.setProperty('--i', i);
  row.dataset.ti = ti;
  row.innerHTML = `<span class="track-num">${i+1}</span><span class="compact-name">${t.name}</span><span class="compact-meta">${t.album}</span>`;
  return row;
}

function buildTableView(trackIdxs) {
  const tbl = el('table','table-view');
  tbl.innerHTML = `<thead><tr><th class="table-num">#</th><th style="width:40%">Título</th><th>Álbum</th><th class="table-stars">★</th><th class="table-fav">♥</th></tr></thead><tbody></tbody>`;
  const tbody = tbl.querySelector('tbody');
  trackIdxs.forEach((ti, i) => {
    const t = tracks[ti];
    const rating = ratings[t.path] || 0;
    const isFav  = favorites.has(t.path);
    const tr = el('tr', ti === currentIndex ? 'playing' : '');
    tr.style.setProperty('--i', i);
    tr.innerHTML = `<td class="table-num">${i+1}</td><td class="table-title" title="${t.name}">${t.name}</td><td class="table-album" title="${t.album}">${t.album}</td><td class="table-stars"><div class="track-star-row">${[1,2,3,4,5].map(n=>`<span class="track-star${n<=rating?' on':''}" data-n="${n}">★</span>`).join('')}</div></td><td class="table-fav"><span class="track-fav${isFav?' on':''}">♥</span></td>`;
    tr.querySelectorAll('.track-star').forEach(s => s.addEventListener('click', e => { e.stopPropagation(); setRating(t.path, parseInt(s.dataset.n)); savePrefs(); if (ti===currentIndex) updateMbFavStars(); }));
    tr.querySelector('.track-fav').addEventListener('click', e => { e.stopPropagation(); favorites.has(t.path) ? favorites.delete(t.path) : favorites.add(t.path); if (ti===currentIndex) updateMbFavStars(); savePrefs(); });
    tr.addEventListener('click', () => playTrack(ti, trackIdxs, 'album'));
    tbody.appendChild(tr);
  });
  return tbl;
}

function setRating(path, n) {
  ratings[path] = (ratings[path] === n) ? 0 : n;
}

/* ===== PLAY GROUP / TRACK ===== */
function playGroup(type, group) {
  playTrack(group.tracks[0], group.tracks, type === 'album' ? 'album' : 'artist');
}

let ytRetried = false;
async function playTrack(idx, newQueue, mode) {
  queue    = newQueue;
  queuePos = queue.indexOf(idx);
  if (queuePos < 0) { queue = [idx]; queuePos = 0; }
  queueMode    = mode;
  currentIndex = idx;
  ytRetried    = false;
  const t = tracks[idx];
  isPlaying = true;
  updatePlayerUI();
  updateQueueUI();

  let src;
  if (t.online && !t.stream) {
    if (t._stream) {
      src = t._stream;
    } else {
      elTrackAlbum.textContent = 'Cargando audio…';
      src = t.source === 'youtube'
        ? await window.musicAPI.getYoutubeStream(t.videoId, streamQuality)
        : await window.musicAPI.youtubeResolve(t.query, streamQuality);
      if (currentIndex !== idx) return; // user changed track while resolving
      if (!src) {
        isPlaying = false;
        $('icon-play').style.display = ''; $('icon-pause').style.display = 'none';
        elMbPlayIcon.style.display = ''; elMbPauseIcon.style.display = 'none';
        elTrackAlbum.textContent = 'No se pudo cargar el audio';
        return;
      }
      t._stream = src;
    }
  } else if (t.online) {
    src = t.stream;
  } else {
    src = `file://${t.path.replace(/\\/g,'/')}`;
  }
  elAudio.src = src;
  elAudio.play().catch(()=>{});
  updatePlayerUI();
}

function updatePlayerUI() {
  const t = tracks[currentIndex];
  if (!t) return;
  elTrackTitle.textContent  = t.name;
  elTrackArtist.textContent = t.artist;
  elTrackAlbum.textContent  = t.album || (t.online ? 'En línea' : '');
  elMbTitle.textContent     = t.name;
  elMbArtist.textContent    = t.artist;
  $('icon-play').style.display  = isPlaying ? 'none' : '';
  $('icon-pause').style.display = isPlaying ? '' : 'none';
  elMbPlayIcon.style.display  = isPlaying ? 'none' : '';
  elMbPauseIcon.style.display = isPlaying ? '' : 'none';
  elCoverArt.classList.remove('has-art');
  const prevImg = elCoverArt.querySelector('img');
  if (prevImg) prevImg.remove();
  const prevBadge = elCoverArt.querySelector('.src-badge');
  if (prevBadge) prevBadge.remove();
  elCoverArt.insertAdjacentHTML('beforeend', srcBadge(!!t.online));
  loadArt(t.path).then(url => {
    if (!url) return;
    const img = document.createElement('img');
    img.src = url;
    elCoverArt.insertBefore(img, elCoverArt.firstChild);
    elCoverArt.classList.add('has-art');
    elMbArt.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
  });
  updateMbFavStars();
}

function updateMbFavStars() {
  const t = tracks[currentIndex];
  if (!t) return;
  const rating = ratings[t.path] || 0;
  const isFav  = favorites.has(t.path);
  elMbStars.innerHTML = [1,2,3,4,5].map(n=>`<span class="mbs${n<=rating?' on':''}" data-n="${n}">★</span>`).join('');
  elMbStars.querySelectorAll('.mbs').forEach(s => s.addEventListener('click', () => { setRating(t.path, parseInt(s.dataset.n)); updateMbFavStars(); savePrefs(); }));
  elMbFav.classList.toggle('on', isFav);
}

/* ===== AUDIO EVENTS ===== */
elAudio.addEventListener('timeupdate', () => {
  const dur = elAudio.duration || 0, cur = elAudio.currentTime;
  const pct = dur ? (cur / dur * 100) : 0;
  elProgress.style.width   = pct + '%';
  elThumb.style.left       = pct + '%';
  elTimeCur.textContent    = fmt(cur);
  elTimeTot.textContent    = fmt(dur);
  elMbProgFill.style.width = pct + '%';
  elMbTimeCur.textContent  = fmt(cur);
  elMbTimeTot.textContent  = fmt(dur);
});

elAudio.addEventListener('error', () => {
  const t = tracks[currentIndex];
  if (t && t.online && !t.stream && !ytRetried) {
    ytRetried = true;
    t._stream = null; // URL likely expired — force a fresh resolve
    playTrack(currentIndex, queue, queueMode);
  }
});

elAudio.addEventListener('ended', () => {
  if (queuePos < queue.length - 1) {
    queuePos++;
    currentIndex = queue[queuePos];
    playTrack(currentIndex, queue, queueMode);
  } else {
    isPlaying = false;
    $('icon-play').style.display  = '';
    $('icon-pause').style.display = 'none';
    elMbPlayIcon.style.display    = '';
    elMbPauseIcon.style.display   = 'none';
  }
});

$('progress-bar').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  elAudio.currentTime = ((e.clientX - r.left) / r.width) * (elAudio.duration || 0);
});
$('mb-prog-bar').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  elAudio.currentTime = ((e.clientX - r.left) / r.width) * (elAudio.duration || 0);
});

$('btn-play').addEventListener('click', () => {
  if (!tracks.length) return;
  if (isPlaying) { elAudio.pause(); isPlaying = false; }
  else { elAudio.play().catch(()=>{}); isPlaying = true; }
  $('icon-play').style.display  = isPlaying ? 'none' : '';
  $('icon-pause').style.display = isPlaying ? '' : 'none';
  elMbPlayIcon.style.display    = isPlaying ? 'none' : '';
  elMbPauseIcon.style.display   = isPlaying ? '' : 'none';
});
$('btn-prev').addEventListener('click', () => {
  if (elAudio.currentTime > 3) { elAudio.currentTime = 0; return; }
  if (queuePos > 0) { queuePos--; currentIndex = queue[queuePos]; playTrack(currentIndex, queue, queueMode); }
});
$('btn-next').addEventListener('click', () => {
  if (queuePos < queue.length - 1) { queuePos++; currentIndex = queue[queuePos]; playTrack(currentIndex, queue, queueMode); }
});
$('mb-play').addEventListener('click', () => $('btn-play').click());
$('mb-prev').addEventListener('click', () => $('btn-prev').click());
$('mb-next').addEventListener('click', () => $('btn-next').click());
$('mb-fav').addEventListener('click', () => {
  const t = tracks[currentIndex];
  if (!t) return;
  favorites.has(t.path) ? favorites.delete(t.path) : favorites.add(t.path);
  updateMbFavStars();
  savePrefs();
});

elVolumeSlider.addEventListener('input', e => { elAudio.volume = e.target.value / 100; });
elMbVolume.addEventListener('input', e => { elAudio.volume = e.target.value / 100; elVolumeSlider.value = e.target.value; });
elAudio.volume = 0.8;

/* ===== PLAYER COLLAPSE ===== */
let isCollapsed = false;
function setCollapsed(c) {
  isCollapsed = c;
  $('player').style.display        = c ? 'none' : '';
  $('resize-handle').style.display = c ? 'none' : '';
  elMiniBar.classList.toggle('visible', c);
  savePrefs();
}
$('player-collapse-btn').addEventListener('click', () => setCollapsed(true));
$('mb-expand').addEventListener('click', () => setCollapsed(false));

/* ===== RESIZE HANDLE ===== */
let resizing = false, resizeStart = 0, playerStartW = 300;
$('resize-handle').addEventListener('mousedown', e => {
  resizing = true; resizeStart = e.clientX; playerStartW = $('player').offsetWidth;
  document.body.style.cssText += ';cursor:col-resize;user-select:none';
});
document.addEventListener('mousemove', e => {
  if (!resizing) return;
  const newW = Math.min(420, Math.max(220, playerStartW + (resizeStart - e.clientX)));
  const p = $('player');
  p.style.width = p.style.minWidth = p.style.maxWidth = newW + 'px';
});
document.addEventListener('mouseup', () => { if (resizing) { resizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; } });

/* ===== QUEUE ===== */
function updateQueueUI() {
  elQueuePos.textContent = queue.length ? `${queuePos+1} / ${queue.length}` : '—';
  elQueueList.innerHTML  = '';
  if (queueMode === 'album') {
    queue.forEach((ti, pos) => {
      const t = tracks[ti];
      const item = el('div', `queue-item${pos===queuePos?' active':''}`);
      item.innerHTML = `<span class="qi-num">${pos+1}</span><div class="qi-thumb"><svg viewBox="0 0 24 24" fill="var(--player-text2)"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div><span class="qi-name">${t.name}</span>`;
      loadArt(t.path).then(url => { if (url) item.querySelector('.qi-thumb').innerHTML = `<img src="${url}" alt="">`; });
      item.addEventListener('click', () => { queuePos = pos; currentIndex = queue[queuePos]; playTrack(currentIndex, queue, queueMode); });
      elQueueList.appendChild(item);
    });
  } else {
    const albumMap = new Map();
    queue.forEach((ti, pos) => {
      const t = tracks[ti];
      const key = `${t.album}|||${t.artist}`;
      if (!albumMap.has(key)) albumMap.set(key, { album: t.album, items: [] });
      albumMap.get(key).items.push({ ti, pos });
    });
    albumMap.forEach((data, key) => {
      const isOpen = key === expandedQueueAlbum;
      const group = el('div', `queue-album-group${isOpen?' open':''}`);
      group.innerHTML = `<div class="queue-album-header"><span class="queue-album-arrow">▶</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${data.album}</span></div><div class="queue-album-songs"></div>`;
      group.querySelector('.queue-album-header').addEventListener('click', () => { expandedQueueAlbum = isOpen ? null : key; updateQueueUI(); });
      const songsCont = group.querySelector('.queue-album-songs');
      data.items.forEach(({ ti, pos }) => {
        const t = tracks[ti];
        const item = el('div', `queue-item${pos===queuePos?' active':''}`);
        item.innerHTML = `<span class="qi-num">${pos+1}</span><div class="qi-thumb"></div><span class="qi-name">${t.name}</span>`;
        loadArt(t.path).then(url => { if (url) item.querySelector('.qi-thumb').innerHTML = `<img src="${url}" alt="">`; });
        item.addEventListener('click', () => { queuePos = pos; currentIndex = queue[queuePos]; playTrack(currentIndex, queue, queueMode); });
        songsCont.appendChild(item);
      });
      elQueueList.appendChild(group);
    });
  }
}

/* ===== COVER FLOW ===== */
$('cf-toggle-btn').addEventListener('click', () => {
  cfMode = !cfMode;
  $('cf-toggle-btn').classList.toggle('active', cfMode);
  closeDetailPanel();
  closeInlineDetail();
  renderLibrary();
  savePrefs();
});

function cfGroups() {
  return currentTab === 'artists' ? groupByArtist() : groupByAlbum();
}

function applyCfFilter() {
  const all = cfGroups();
  const term = cfFilter.trim().toLowerCase();
  cfAlbums = term
    ? all.filter(g => (g.album || g.artist || '').toLowerCase().includes(term) || (g.artist || '').toLowerCase().includes(term))
    : all;
}

function renderCoverFlow() {
  applyCfFilter();
  if (!cfAlbums.length && !cfFilter) { elTrackList.innerHTML = '<div class="empty-state"><p>No hay elementos</p></div>'; return; }
  cfIndex = Math.min(cfIndex, Math.max(0, cfAlbums.length - 1));

  const isArtist = currentTab === 'artists';
  const view = el('div','');
  view.id = 'coverflow-view';
  view.classList.add('cf-active');
  view.innerHTML = `
    <div id="cf-bg"></div>
    <div id="cf-search-row">
      <span class="cf-search-icon">${SEARCH_ICON}</span>
      <input type="text" id="cf-search-input" placeholder="${isArtist ? 'Filtrar artistas…' : 'Filtrar álbumes…'}" autocomplete="off" spellcheck="false" value="${cfFilter.replace(/"/g,'&quot;')}">
      <button id="cf-search-clear" title="Limpiar" style="${cfFilter ? '' : 'display:none'}">✕</button>
    </div>
    <div id="cf-stage-wrap">
      <div id="cf-stage"></div>
      <div id="cf-reflection"><img src="" alt=""></div>
    </div>
    <div id="cf-nav-row">
      <button id="cf-prev-btn">‹</button>
      <div id="cf-info-center">
        <div id="cf-album-name"></div>
        <div id="cf-album-sub"></div>
      </div>
      <button id="cf-next-btn">›</button>
    </div>
    <div id="cf-effect-row">
      <span class="cf-effect-label">Efecto</span>
      <span class="cf-effect-icon cf-flat">▱</span>
      <input type="range" id="cf-effect-slider" min="0" max="100" value="${cfEffect}">
      <span class="cf-effect-icon cf-deep">◈</span>
    </div>
    ${isArtist ? '<div id="cf-artist-albums"></div>' : ''}
    <button id="cf-play-btn">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      Reproducir
    </button>
    <div id="cf-tracklist"></div>`;

  elTrackList.innerHTML = '';

  if (!cfAlbums.length) {
    elTrackList.appendChild(view);
    wireSearchRow(view);
    return;
  }

  elTrackList.appendChild(view);

  buildCfCards();
  updateCfPositions(false);
  loadCfArt(cfIndex);
  updateCfInfo();

  view.querySelector('#cf-prev-btn').addEventListener('click', () => setCfIndex(cfIndex - 1));
  view.querySelector('#cf-next-btn').addEventListener('click', () => setCfIndex(cfIndex + 1));
  view.querySelector('#cf-play-btn').addEventListener('click', cfPlayCurrent);
  view.querySelector('#cf-effect-slider').addEventListener('input', e => {
    cfEffect = parseInt(e.target.value);
    updateCfPositions(false);
    savePrefs();
  });

  wireSearchRow(view);
}

function wireSearchRow(view) {
  const input = view.querySelector('#cf-search-input');
  const clearBtn = view.querySelector('#cf-search-clear');
  if (!input) return;
  input.addEventListener('input', () => {
    cfFilter = input.value;
    clearBtn.style.display = cfFilter ? '' : 'none';
    applyCfFilter();
    cfIndex = 0;
    buildCfCards();
    updateCfPositions(false);
    if (cfAlbums.length) { loadCfArt(0); updateCfInfo(); }
  });
  clearBtn && clearBtn.addEventListener('click', () => {
    cfFilter = '';
    input.value = '';
    clearBtn.style.display = 'none';
    applyCfFilter();
    cfIndex = 0;
    buildCfCards();
    updateCfPositions(false);
    if (cfAlbums.length) { loadCfArt(0); updateCfInfo(); }
    input.focus();
  });
}

function cfPlayCurrent() {
  const g = cfAlbums[cfIndex];
  if (!g) return;
  if (currentTab === 'artists') {
    const albIdx = cfArtistAlbumIdx[g.artist] || 0;
    const artistAlbs = groupByAlbum().filter(a => a.artist === g.artist);
    const alb = artistAlbs[albIdx] || artistAlbs[0];
    if (alb) playTrack(alb.tracks[0], alb.tracks, 'album');
  } else {
    playTrack(g.tracks[0], g.tracks, 'album');
  }
}

function buildCfCards() {
  const stage = document.querySelector('#cf-stage');
  if (!stage) return;
  stage.innerHTML = '';
  cfAlbums.forEach((g, i) => {
    const card = el('div','cf-card');
    card.dataset.cfIdx = i;
    card.innerHTML = `<div class="cf-placeholder"><svg viewBox="0 0 24 24" fill="rgba(255,255,255,.2)" width="70" height="70"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>${srcBadge(!!g.online)}`;
    card.addEventListener('click', () => { if (i !== cfIndex) setCfIndex(i); });
    stage.appendChild(card);
  });
}

function updateCfPositions(animate) {
  const eff = cfEffect / 100; // 0→flat, 1→full effect
  document.querySelectorAll('.cf-card').forEach(card => {
    const i = parseInt(card.dataset.cfIdx);
    const offset = i - cfIndex;
    const abs = Math.abs(offset);
    card.style.transition = animate ? 'transform .5s cubic-bezier(.4,0,.2,1), opacity .5s ease, box-shadow .5s ease' : 'none';
    if (abs > 5) { card.style.opacity = '0'; card.style.pointerEvents = 'none'; return; }

    const sign = offset < 0 ? -1 : 1;
    // Base horizontal spread — always present regardless of effect
    const baseTx = offset === 0 ? 0 : sign * (150 + (abs - 1) * 110);
    // Effect-dependent: rotation, Z pull-back, extra compression
    const ry     = offset === 0 ? 0 : sign * -(55 * eff + 5);
    const tz     = offset === 0 ? 0 : -Math.min(abs * 80 * eff, 260 * eff);
    const comprX = eff * sign * (abs > 1 ? -(abs - 1) * 30 : 0); // pull closer when effect strong
    const tx     = baseTx + comprX;
    const scale  = offset === 0 ? 1 : Math.max(0.65, 1 - abs * (0.08 * eff + 0.02));
    const opacity = offset === 0 ? 1 : Math.max(0.2, 1 - abs * (0.18 * eff + 0.06));

    card.style.transform = `translateX(${tx}px) rotateY(${ry}deg) translateZ(${tz}px) scale(${scale})`;
    card.style.opacity   = opacity;
    card.style.zIndex    = 20 - abs;
    card.style.pointerEvents = offset === 0 ? 'none' : 'auto';
    card.classList.toggle('cf-center', offset === 0);
  });
}

function setCfIndex(i) {
  cfIndex = Math.max(0, Math.min(cfAlbums.length - 1, i));
  updateCfPositions(true);
  loadCfArt(cfIndex);
  updateCfInfo();
}

function loadCfArt(idx) {
  for (let d = -3; d <= 3; d++) {
    const i = idx + d;
    if (i < 0 || i >= cfAlbums.length) continue;
    const g = cfAlbums[i];
    const artFile = currentTab === 'artists'
      ? (groupByAlbum().find(a => a.artist === g.artist) || {}).artFile || g.artFile
      : g.artFile;
    const card = document.querySelector(`.cf-card[data-cf-idx="${i}"]`);
    if (!card || card.querySelector('img')) {
      if (i === idx && artCache.has(artFile) && artCache.get(artFile)) updateCfBg(artCache.get(artFile));
      continue;
    }
    loadArt(artFile).then(url => {
      if (!url) return;
      if (card.querySelector('img')) return;
      const img = document.createElement('img');
      img.src = url; img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
      card.innerHTML = '';
      card.appendChild(img);
      card.insertAdjacentHTML('beforeend', srcBadge(!!g.online));
      if (i === cfIndex) updateCfBg(url);
    });
  }
}

function updateCfBg(url) {
  const bg   = document.querySelector('#cf-bg');
  const refl = document.querySelector('#cf-reflection img');
  if (bg)   bg.style.backgroundImage = `url("${url}")`;
  if (refl) refl.src = url;
}

function updateCfInfo() {
  const g = cfAlbums[cfIndex];
  if (!g) return;

  const nameEl = document.querySelector('#cf-album-name');
  const subEl  = document.querySelector('#cf-album-sub');

  if (currentTab === 'artists') {
    if (nameEl) nameEl.textContent = g.artist;
    const artistAlbs = groupByAlbum().filter(a => a.artist === g.artist);
    if (subEl) subEl.textContent = `${artistAlbs.length} álbumes · ${g.tracks.length} canciones`;
    renderCfArtistAlbums(g, artistAlbs);
  } else {
    if (nameEl) nameEl.textContent = g.album;
    if (subEl)  subEl.textContent  = `${g.artist} · ${g.tracks.length} canciones`;
    renderCfTracks(g.tracks);
  }
}

function renderCfArtistAlbums(g, artistAlbs) {
  const cont = document.querySelector('#cf-artist-albums');
  if (!cont) return;
  const selIdx = cfArtistAlbumIdx[g.artist] || 0;
  cont.innerHTML = '';
  artistAlbs.forEach((alb, i) => {
    const chip = el('button', `cf-alb-chip${i === selIdx ? ' active' : ''}`);
    chip.dataset.albIdx = i;

    // thumbnail
    const thumb = el('div', 'cf-alb-chip-thumb');
    chip.appendChild(thumb);
    const label = el('span', 'cf-alb-chip-name');
    label.textContent = alb.album;
    chip.appendChild(label);

    loadArt(alb.artFile).then(url => {
      if (url) { thumb.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`; }
      else { thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="rgba(255,255,255,.3)" width="18" height="18"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`; }
    });

    chip.addEventListener('click', () => {
      cfArtistAlbumIdx[g.artist] = i;
      cont.querySelectorAll('.cf-alb-chip').forEach(c => c.classList.toggle('active', c.dataset.albIdx == i));
      renderCfTracks(alb.tracks);
      // update bg with this album's art
      loadArt(alb.artFile).then(url => { if (url) updateCfBg(url); });
    });
    cont.appendChild(chip);
  });

  // render tracks for selected album
  const selAlb = artistAlbs[selIdx] || artistAlbs[0];
  if (selAlb) renderCfTracks(selAlb.tracks);
}

function renderCfTracks(trackIdxs) {
  const cont = document.querySelector('#cf-tracklist');
  if (!cont) return;
  const w = el('div','compact-view');
  trackIdxs.forEach((ti, i) => {
    const r = buildCompactRow(tracks[ti], ti, i);
    r.addEventListener('click', () => playTrack(ti, trackIdxs, 'album'));
    w.appendChild(r);
  });
  cont.innerHTML = '';
  cont.appendChild(w);
}

/* keyboard nav for cover flow */
document.addEventListener('keydown', e => {
  if (!cfMode) return;
  if (e.key === 'ArrowLeft')  setCfIndex(cfIndex - 1);
  if (e.key === 'ArrowRight') setCfIndex(cfIndex + 1);
});

/* ===== THEME ===== */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === theme));
}
document.querySelectorAll('.theme-dot').forEach(dot => dot.addEventListener('click', () => { applyTheme(dot.dataset.theme); savePrefs(); }));

/* ===== STREAM QUALITY ===== */
document.querySelectorAll('.sq-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    streamQuality = btn.dataset.quality;
    tracks.forEach(t => { if (t.online) t._stream = null; }); // clear cached URLs
    document.querySelectorAll('.sq-btn').forEach(b => b.classList.toggle('active', b === btn));
    savePrefs();
  });
});

/* ===== PREFS ===== */
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      theme: document.documentElement.getAttribute('data-theme') || 'white',
      gridSize,
      detailViewMode,
      detailPosMode,
      collapsed: isCollapsed,
      cfMode,
      cfEffect,
      streamQuality,
      ratings,
      favorites: [...favorites],
      thumbSize: $('detail-thumb-slider').value,
      volume: elVolumeSlider.value,
      folderPath: lastFolderPath,
      favSortBy,
      favMinStars,
    }));
  } catch {}
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (p.theme) applyTheme(p.theme);
    if (p.gridSize) {
      gridSize = p.gridSize;
      $('grid-size-slider').value = gridSize;
      document.documentElement.style.setProperty('--grid-size', gridSize + 'px');
    }
    if (p.detailViewMode) { detailViewMode = p.detailViewMode; syncViewModeButtons(); }
    if (p.detailPosMode && p.detailPosMode !== 'right') {
      detailPosMode = p.detailPosMode;
      document.querySelectorAll('.dp-btn').forEach(b => b.classList.toggle('active', b.dataset.pos === detailPosMode));
    }
    if (p.collapsed) setCollapsed(true);
    if (p.cfMode)    { cfMode = true; $('cf-toggle-btn').classList.add('active'); }
    if (p.cfEffect !== undefined) cfEffect = p.cfEffect;
    if (p.streamQuality) {
      streamQuality = p.streamQuality;
      document.querySelectorAll('.sq-btn').forEach(b => b.classList.toggle('active', b.dataset.quality === streamQuality));
    }
    if (p.ratings)   ratings   = p.ratings;
    if (p.favorites) favorites = new Set(p.favorites);
    if (p.favSortBy) favSortBy = p.favSortBy;
    if (p.favMinStars != null) favMinStars = p.favMinStars;
    if (p.folderPath) lastFolderPath = p.folderPath;
    if (p.thumbSize) {
      $('detail-thumb-slider').value = p.thumbSize;
      document.documentElement.style.setProperty('--detail-thumb-size', p.thumbSize + 'px');
    }
    if (p.volume) {
      elVolumeSlider.value = p.volume;
      elMbVolume.value     = p.volume;
      elAudio.volume       = p.volume / 100;
    }
  } catch {}
}

/* ===== SETTINGS PANEL ===== */
$('settings-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('settings-panel').classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!$('settings-wrap').contains(e.target)) $('settings-panel').classList.remove('open');
});

/* ===== RIGHT-CLICK CONTEXT MENU ===== */
const ctxMenu = el('div','ctx-menu');
ctxMenu.style.display = 'none';
document.body.appendChild(ctxMenu);

function showCtxMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  items.forEach(item => {
    if (item === '---') {
      ctxMenu.appendChild(el('div','ctx-sep'));
    } else {
      const btn = el('button','ctx-item', item.label);
      if (item.danger) btn.classList.add('danger');
      btn.addEventListener('click', () => { item.action(); hideCtxMenu(); });
      ctxMenu.appendChild(btn);
    }
  });
  ctxMenu.style.display = 'block';
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = ctxMenu.offsetWidth || 200, ch = ctxMenu.offsetHeight || 200;
  ctxMenu.style.left = (x + cw > vw ? x - cw : x) + 'px';
  ctxMenu.style.top  = (y + ch > vh ? y - ch : y) + 'px';
}
function hideCtxMenu() { ctxMenu.style.display = 'none'; }
document.addEventListener('click', hideCtxMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

function trackCtxMenu(ti, queue, e) {
  e.preventDefault();
  const t = tracks[ti];
  if (!t) return;
  const isFav = favorites.has(t.path);
  const curRating = ratings[t.path] || 0;
  showCtxMenu(e.clientX, e.clientY, [
    { label: '▶  Reproducir',           action: () => playTrack(ti, queue, 'album') },
    { label: '+ Agregar al final de la cola', action: () => { queue.push(ti); } },
    '---',
    { label: isFav ? '♥  Quitar de favoritos' : '♡  Añadir a favoritos', action: () => {
      isFav ? favorites.delete(t.path) : favorites.add(t.path);
      savePrefs(); renderLibrary();
    }},
    { label: `★  Calificar: ${[1,2,3,4,5].map(n => n<=curRating?'★':'☆').join('')}`, action: ()=>{} },
    ...([1,2,3,4,5].map(n => ({ label: `${'★'.repeat(n)}${'☆'.repeat(5-n)}`, action: () => { setRating(t.path, n); savePrefs(); renderLibrary(); } }))),
    { label: '✕  Sin calificación', action: () => { ratings[t.path] = 0; savePrefs(); renderLibrary(); } },
    '---',
    ...(t.online ? [{ label: t.inLibrary ? '✓  En mi biblioteca' : '＋ Añadir a biblioteca', action: () => { setTrackInLibrary(ti, !t.inLibrary); saveLibrary(); renderLibrary(); } }, '---'] : []),
    { label: '📋  Copiar título',   action: () => navigator.clipboard?.writeText(t.name) },
    { label: '📋  Copiar artista',  action: () => navigator.clipboard?.writeText(t.artist) },
  ]);
}

document.addEventListener('contextmenu', e => {
  const row = e.target.closest('.track-row, .compact-row');
  if (row) {
    const ti = parseInt(row.dataset.ti ?? -1);
    if (ti >= 0 && tracks[ti]) {
      trackCtxMenu(ti, queue.length ? queue : [ti], e);
    }
    return;
  }
  const card = e.target.closest('.grid-card');
  if (card) {
    e.preventDefault();
    // album/artist card — show group context menu
    const key  = card.dataset.key;
    const type = card.dataset.type;
    let g;
    if (type === 'album') { const [alb, art] = key.split('|||'); g = groupByAlbum().find(a => a.album===alb && a.artist===art); }
    else g = groupByArtist().find(a => a.artist === key);
    if (!g) return;
    const faved = g.tracks.every(ti => favorites.has(tracks[ti]?.path));
    showCtxMenu(e.clientX, e.clientY, [
      { label: '▶  Reproducir',    action: () => playGroup(type, g) },
      '---',
      { label: faved ? '♥  Quitar de favoritos' : '♡  Añadir a favoritos', action: () => {
        g.tracks.forEach(ti => { if (tracks[ti]) { faved ? favorites.delete(tracks[ti].path) : favorites.add(tracks[ti].path); } });
        savePrefs(); renderLibrary();
      }},
    ]);
    return;
  }
});

/* ===== FILTER BAR AUTO-HIDE ON SCROLL ===== */
{
  let _prevST = 0;
  elTrackList.addEventListener('scroll', () => {
    const bar = elTrackList.querySelector('.lib-filter-bar');
    if (!bar) return;
    const st = elTrackList.scrollTop;
    bar.classList.toggle('bar-hidden', st > _prevST && st > 30);
    _prevST = st;
  }, { passive: true });
}

/* ===== INIT ===== */
initThumbObserver();
loadPrefs();
if (lastFolderPath) {
  window.musicAPI.readMusicFiles(lastFolderPath).then(localFiles => {
    tracks = localFiles;
    artCache.clear();
    onlineIndex.clear();
    loadLibrary();
    renderLibrary();
  }).catch(() => { loadLibrary(); renderLibrary(); });
} else {
  loadLibrary();
  renderLibrary();
}
$('cf-toggle-btn').style.display = (currentTab === 'albums' || currentTab === 'artists') ? '' : 'none';
