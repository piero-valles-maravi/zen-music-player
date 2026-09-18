const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musicAPI', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  readMusicFiles: (folderPath) => ipcRenderer.invoke('read-music-files', folderPath),
  getCoverArt: (filePath) => ipcRenderer.invoke('get-cover-art', filePath),
  searchOnline: (query) => ipcRenderer.invoke('search-online', query),
  exploreHome: () => ipcRenderer.invoke('explore-home'),
  getAlbumTracks: (albumId) => ipcRenderer.invoke('get-album-tracks', albumId),
  getArtistTracks: (artistId) => ipcRenderer.invoke('get-artist-tracks', artistId),
  getArtistAlbums: (artistId) => ipcRenderer.invoke('get-artist-albums', artistId),
  getYoutubeStream: (videoId, quality) => ipcRenderer.invoke('get-youtube-stream', videoId, quality),
  youtubeResolve: (query, quality) => ipcRenderer.invoke('youtube-resolve', query, quality),
});
