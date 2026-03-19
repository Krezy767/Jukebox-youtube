# Jukebox Troubleshooting Guide

This document describes the autoplay/fallback song issues encountered and the solutions implemented.

## Problem Summary

When the queue was empty and a fallback (autoplay) song should play, several issues occurred:

1. **UI Mismatch**: The host page showed "Living on a Prayer" but Spotify played "We Are the Champions"
2. **Song Repeating**: When a song ended with an empty queue, the same song would play again instead of a new fallback
3. **Brief Flash**: A new song would appear in UI for a second, then get overwritten by the previous song
4. **Restriction Errors**: "Player command failed: Restriction violated" (403 errors)
5. **Force Play Spam**: Clicking Force Play multiple times caused rapid retry loops

## Root Causes

### 1. Double Playback Control
Both the **server** and **client** were trying to control Spotify playback simultaneously:
- Server called Spotify Web API to play a track
- Client tried to play/resume via SDK
- These conflicted, causing race conditions

### 2. SDK Limitations
The Spotify Web Playback SDK **does not have a `play()` method**:
```javascript
// ❌ This doesn't exist!
player.play({ uris: [uri] })

// ✅ SDK only has:
player.resume()
player.pause()
player.togglePlay()
```

To load a specific track, you **must** use the Spotify Web API.

### 3. Device Activation
The Spotify API play command fails silently if the SDK device isn't the "active" playback device. The device must be activated first via:
```javascript
PUT /v1/me/player
{ device_ids: [deviceId], play: false }
```

### 4. Browser Autoplay Restrictions
Modern browsers block audio autoplay until the user interacts with the page. This causes:
- "Restriction violated" errors
- API calls succeed but no audio plays
- Need for explicit user click before first playback

### 5. UI Overwrite Race Condition
Multiple code paths were updating the UI:
- `socket.on('queueUpdate')` from server
- `player_state_changed` from SDK
- Polling sync every 3 seconds
- Track end detection (timeout + paused state check)

These could overwrite each other during track transitions.

### 6. Missing State Tracking
The `currentTrack` variable wasn't being set in `requestNextTrack()`, causing:
- `currentTrack?.isFallback` to always be undefined
- Incorrect UI rendering
- State inconsistencies

## Solutions Implemented

### Solution 1: Server Controls Selection, Client Controls Playback

**Before:**
- Server tried to play via API (failed due to device activation)
- Client tried to play as fallback (conflicted)

**After:**
- Server selects the track and broadcasts via socket
- Server emits `playTrack` event with track URI
- Client receives event and plays via API

```javascript
// server.js
io.emit('playTrack', { 
  uri: `spotify:track:${next.trackId}`, 
  trackId: next.trackId,
  requestId: `${next.trackId}_${Date.now()}`  // For deduplication
});
```

### Solution 2: Two-Step Device Activation

When playing via API, first activate the device, then play:

```javascript
// Step 1: Make device active
await fetch('https://api.spotify.com/v1/me/player', {
  method: 'PUT',
  body: JSON.stringify({ 
    device_ids: [deviceId],
    play: false
  })
});

// Wait for activation
await new Promise(r => setTimeout(r, 300));

// Step 2: Play the track
await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
  method: 'PUT',
  body: JSON.stringify({ uris: [uri] })
});
```

### Solution 3: Click-to-Start Overlay

For browser autoplay restrictions, added a full-screen overlay:

```javascript
// Track user interaction
let hasUserInteracted = false;
document.addEventListener('click', () => {
  hasUserInteracted = true;
}, { once: true });

// Show overlay if trying to play without interaction
if (!hasUserInteracted) {
  showClickToPlay(trackTitle);
  return;
}
```

The overlay:
- Blocks the UI with a big "▶ Start Playing" button
- Shows which track is ready
- Hides after first click
- Future plays work automatically

### Solution 4: Deduplication & Debouncing

**Play request deduplication:**
```javascript
let lastPlayRequestId = null;
socket.on('playTrack', ({ requestId }) => {
  if (requestId === lastPlayRequestId) return; // Ignore duplicate
  lastPlayRequestId = requestId;
  // ... play
});
```

**Force Play debouncing:**
```javascript
let isForcePlaying = false;
async function forcePlay() {
  if (isForcePlaying) return;
  isForcePlaying = true;
  setTimeout(() => isForcePlaying = false, 3000);
  // ... play
}
```

### Solution 5: UI Sync Protection

Track the last displayed track to prevent overwrites:

```javascript
// Track what we've already shown
if (!window.lastPlayedTrackId) window.lastPlayedTrackId = null;

// Only update UI for NEW tracks
if (actualTrack.id !== window.lastPlayedTrackId) {
  window.lastPlayedTrackId = actualTrack.id;
  renderNowPlaying(actualTrack);
}
```

Also added guards to socket handler and polling sync:
```javascript
// Only update UI if it's actually different
if (serverTrack.trackId !== displayedTrackId) {
  renderNowPlaying(serverTrack);
  displayedTrackId = serverTrack.trackId;
}
```

### Solution 6: Fix Missing State Assignment

```javascript
// Was missing before!
currentTrack = track;  // Store full track object
currentTrackUri = track.uri;
currentTrackId = track.trackId;
```

## File Changes

### server.js
- Removed direct API playback from `/api/next`
- Added `io.emit('playTrack', ...)` to trigger client playback
- Added `uri` field to track responses for consistency

### public/host.html
- Added `currentTrack`, `currentTrackUri`, `currentTrackId` top-level variables
- Added `window.lastPlayedTrackId` for UI sync protection
- Added `hasUserInteracted` flag for autoplay restrictions
- Added `pendingTrackUri` for click-to-play functionality
- Added `showClickToPlay()` / `hideClickToPlay()` / `startPlaybackFromClick()` functions
- Modified `playTrackWithAPI()` to include device activation step
- Added debouncing to `forcePlay()`
- Added deduplication to `socket.on('playTrack')`
- Modified `player_state_changed` to only update UI for new tracks
- Added guards to socket and polling handlers

## Testing Checklist

- [ ] Load host page, connect Spotify
- [ ] Clear queue and wait for fallback - should show click-to-start overlay
- [ ] Click start - music should play
- [ ] Let song finish with empty queue - next fallback should autoplay
- [ ] Skip via admin - new song should play correctly
- [ ] Add song to queue - should play after current song
- [ ] UI should always match what's actually playing

## Key Learnings

1. **Spotify Web Playback SDK ≠ Spotify Web API**
   - SDK: Browser-based player, limited control (resume/pause only)
   - API: Full control (play specific tracks, transfer devices)

2. **Device Activation is Required**
   - A device must be made "active" before playback commands work
   - The SDK device doesn't auto-activate

3. **Browser Autoplay is Strict**
   - User interaction required before any audio
   - Must track this state and handle gracefully

4. **Race Conditions are Everywhere**
   - Server broadcasts, socket events, SDK state changes, polling
   - All can fire at similar times and overwrite each other
   - Need deduplication and careful state tracking

5. **Single Source of Truth**
   - Server should pick what plays
   - Client should execute playback
   - UI should reflect actual Spotify state

## Related Documentation

- [Spotify Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk/)
- [Spotify Web API - Player Endpoints](https://developer.spotify.com/documentation/web-api/reference/#category-player)
- [Chrome Autoplay Policy](https://developer.chrome.com/blog/autoplay/)
