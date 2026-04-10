# Jukebox YouTube — Build Handoff

This is a fork of the Spotify-based Jukebox project. The goal is to rebuild it
using YouTube IFrame Player API for playback and YouTube Music / YouTube Data API
for pool building — completely replacing Spotify.

The user has **YouTube Music Premium** so ads are not an issue.

---

## What this repo is

A full copy of the working Spotify Jukebox. Everything works as-is for Spotify.
The job now is to swap out the Spotify layer for YouTube, keeping everything else
identical (queue logic, guest UI, admin UI, voting, fading, server endpoints).

---

## What needs to change

### 1. `public/host.html` — biggest change
- Remove: Spotify Web Playback SDK script, all Spotify OAuth (`/auth/token`),
  `spotifyPlay()`, `spotifyQueue()`, `transferPlaybackToHost()`, `deviceId` setup
- Add: YouTube IFrame Player API (`https://www.youtube.com/iframe_api`)
- The player loads an invisible/tiny iframe and plays by `videoId`
- All fade logic (tryStartFade, startFadeOut, startFadeIn) stays — just swap
  the play/pause/volume calls to IFrame Player equivalents:
  - `player.playVideo()` / `player.pauseVideo()`
  - `player.setVolume(0-100)` (note: YouTube uses 0-100, not 0-1)
  - `player.seekTo(0)`
  - State events: `onStateChange` (PLAYING=1, PAUSED=2, ENDED=0, BUFFERING=3)
- Track switching: `player.loadVideoById(videoId)` — instant, no HTTP round-trip
- Audio monitoring: since YouTube IFrame has no DRM isolation, you can tap
  `iframe.contentDocument.querySelector('video').captureStream()` into an
  AnalyserNode for real-time silence detection — no permission dialog needed

### 2. `server.js` — medium change
- Remove: Spotify OAuth routes (`/auth/login`, `/auth/callback`, `/auth/token`,
  `/auth/status`), Spotify token refresh, `fetchPlaylistTracks`, genre search
  via Spotify API, `axios` calls to Spotify
- Add: YouTube Data API v3 for search and pool building
  - Search: `GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&key=API_KEY&q=...`
  - Video details (duration): `GET https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=...`
  - Charts/mood: use ytmusicapi (Python sidecar) OR hardcode popular YouTube
    Music playlist IDs and fetch them via Data API
- Pool entries use `videoId` instead of Spotify `trackId`
- No OAuth needed for pool building (API key is enough for public data)
- Remove `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `REDIRECT_URI` env vars
- Add `YOUTUBE_API_KEY` env var

### 3. `public/admin.html` — small change
- Remove: Spotify connect button, PKCE flow, playlist import via Spotify API
- Add: import a YouTube Music playlist by URL/ID using YouTube Data API
- Genre/mood pool: replace Spotify genre search with YouTube mood playlist IDs
  (YouTube Music has curated mood playlists with stable IDs)
- Everything else (pool management, song pool table, admin controls) stays identical

### 4. `public/guest.html` — untouched
No changes needed. Guest search goes to server which searches YouTube instead.

### 5. `render.yaml` — small change
- Remove Spotify env vars, add `YOUTUBE_API_KEY`

---

## Key architectural notes

- Track objects throughout the codebase use `trackId` — rename/remap to `videoId`
  or keep as `trackId` and just store the YouTube videoId there (simpler)
- YouTube IFrame Player is async: `onYouTubeIframeAPIReady` callback fires when
  ready, then `new YT.Player(...)` creates the player
- `onStateChange` replaces the Spotify SDK's `player_state_changed` event
- YouTube doesn't have a "device" concept — no `deviceId`, no transfer needed
- Duration comes from YouTube Data API (`PT3M45S` format — parse ISO 8601)
- Audio monitoring: after player ready, grab the iframe's video element and pipe
  through Web Audio API AnalyserNode for silence/watchdog detection

---

## Build order suggestion

1. **server.js first** — get pool building and search working with YouTube Data API,
   pool entries flowing with videoId. Test via admin panel.
2. **host.html second** — swap playback to IFrame Player, port fade logic, test
   track switching and fades work cleanly.
3. **admin.html third** — YouTube playlist import, mood/genre pool.
4. **Audio monitoring last** — AnalyserNode silence watchdog once playback is stable.

---

## Useful references

- YouTube IFrame Player API: https://developers.google.com/youtube/iframe_api_reference
- YouTube Data API v3: https://developers.google.com/youtube/v3/docs
- ytmusicapi (Python, for mood playlists): https://github.com/sigma67/ytmusicapi
- Get a free YouTube Data API key: Google Cloud Console → Enable YouTube Data API v3
