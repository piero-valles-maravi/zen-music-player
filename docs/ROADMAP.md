# Roadmap and known gaps

> Technical docs are kept in English, matching the code comments.
> *La documentación técnica está en inglés, igual que los comentarios del código. El [README](../README.md) sí es bilingüe.*

Version 1.0.0 is a working player, not a finished one. This file is an honest inventory of what is missing, derived from the code as it stands — not a schedule. Ordering within each section is by how much it hurts day to day, not by commitment.

---

## Playback gaps

These are the ones a user notices in the first hour.

- **No shuffle.** The queue is a plain array played front to back.
- **No repeat** — not track, not queue. The `ended` handler stops at the last item.
- **No playlists.** Favorites plus star ratings are the only way to curate; there is no named, ordered, saved collection.
- **The queue is append-only.** *Agregar al final de la cola* pushes; there is no way to remove an item, reorder it, or play next. Reordering would need drag handling in `updateQueueUI()`.
- **No gapless or crossfade.** A single `<audio>` element means a hard stop between tracks; either feature needs two elements swapping.
- **No OS media integration.** Hardware media keys, the Windows volume flyout and the taskbar thumbnail controls do nothing. The `MediaSession` API plus `setThumbarButtons()` would cover it.
- **No sleep timer, no playback speed, no equalizer.**

## Library gaps

- **One folder at a time.** `folderPath` is a single string; adding a second collection replaces the first. Making it an array touches the scan handler, `loadPrefs`/`savePrefs` and the startup sequence.
- **No filesystem watching.** New files appear only after re-opening the folder; there is no rescan button either.
- **Metadata comes from the folder layout, not the tags.** `read-music-files` derives artist and album from directory names. A well-tagged but flatly-organised collection groups badly, even though `music-metadata` is already a dependency and could read the real tags during the scan.
- **Album art is taken from the album's first track.** If that file has no embedded picture, the whole album falls back to the placeholder.
- **Ratings and favorites are keyed by absolute path.** Moving the collection to another drive orphans them. A content hash, or a rewrite-on-rescan step, would fix it.
- **No tag editing.** The app never writes to your files, which is a deliberate safety property, but it means fixing a wrong album name means leaving the app.

## Online gaps

- **The YouTube match is the top search hit, unverified.** No duration comparison against the Deezer metadata, no channel preference, no way for the user to pick a different match. Comparing `duration` would catch most bad matches cheaply.
- **Resolved video ids are not cached.** URLs must be re-resolved because they expire, but the `videoId` behind them is stable and could be stored in `zen-library-v1`, saving one search per play.
- **No rate-limit or retry handling on Deezer.** Every failure collapses to an empty state with no distinction between "nothing found" and "the request failed".
- **No offline caching of online tracks.** Anything added to the library needs a connection every time.

## Platform and packaging

- **Online playback is Windows-only.** `ytDlpPath()` looks for `yt-dlp.exe` by that exact name. macOS and Linux need the extension-less binary name, even though the Forge makers for `.deb`, `.rpm` and `.zip` are already configured. Local playback is already portable.
- **No application icon.** `packagerConfig` has no `icon`, so packaged builds use Electron's default.
- **No auto-update.** `npm run publish` is wired but no publisher is configured.
- **`webSecurity: false`.** See the note in [ARCHITECTURE.md §1](ARCHITECTURE.md#window-configuration). Serving local files through a custom protocol handler would let it be turned back on.

## Interface

- **Spanish only.** Strings are inline in `index.html` and `renderer.js` with no i18n layer. Extracting them is mechanical but touches every render function.
- **Almost no keyboard support.** Only `←` / `→` in Cover Flow and `Esc` to close the context menu. Space to play/pause and `Ctrl+F` to focus the filter are the obvious first additions.
- **No accessibility pass.** No focus management, no ARIA roles on the custom controls, no visible focus ring on the cards.
- **No drag and drop.** Dropping a folder or a file on the window does nothing.

## Engineering housekeeping

- **No tests.** No unit tests, no smoke test, no CI workflow.
- **No linter.** The `lint` script is a stub that echoes and exits.
- **`renderer.js` is ~1,900 lines.** It is coherently sectioned, but library rendering, Explore, Cover Flow, the player and persistence are separable modules that Vite would happily bundle.
- **Error states are silent.** Most failures are swallowed by empty `catch {}` blocks. That keeps the UI calm but makes anything intermittent hard to diagnose.

---

## Deliberately out of scope

Not oversights:

- **Selling, publishing or distributing builds that bundle `yt-dlp`.** See [Legal and scope](../README.md#-legal-and-scope). This is a personal player and it stays one unless the audio source is replaced with a licensed one.
- **Any audio taken from Deezer.** Its public API is used for metadata and nothing else.
- **Writing to the user's audio files.** The app reads tags; it never modifies them.
- **Accounts, sync or telemetry.** Everything lives in two `localStorage` keys on your machine, and nothing is sent anywhere except the two API calls playback needs.
