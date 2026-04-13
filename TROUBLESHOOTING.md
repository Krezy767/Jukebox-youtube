# YouTube Jukebox Troubleshooting Guide

This document describes technical issues encountered during the migration to YouTube playback and the solutions implemented.

## Problem Summary

1. **YouTube IFrame API Restrictions**: Some videos are blocked from embedding (Error 150).
2. **Audio Quality**: Ensuring the system plays official audio tracks instead of low-quality music videos.
3. **Crossfade & Transitions**: Smoothly transitioning between YouTube tracks in a single IFrame.
4. **Browser Autoplay**: Handling browser policies that block video playback before user interaction.

## Root Causes & Solutions

### 1. YouTube Error 150 (Embedding Disabled)
**Issue**: Some labels disable embedding for specific tracks, causing the player to fail.
**Solution**: Implemented a fallback resolver (`/api/resolve-alternate`) that automatically searches for up to 15 alternates on YouTube Music (specifically targeting `MUSIC_VIDEO_TYPE_ATV`) when an error occurs.

### 2. Prioritizing Audio Quality (ATV)
**Issue**: Standard YouTube searches return music videos with long intros/outros.
**Solution**: The Python microservice specifically filters for `MUSIC_VIDEO_TYPE_ATV` (Audio Track Version). This ensures high-quality studio audio and prevents long cinematic intros.

### 3. Click-to-Start Overlay
**Issue**: Chrome and other browsers block autoplay until a user interacts with the page.
**Solution**: A full-screen overlay on the `host.html` page requires one initial click to "Start the Jukebox," which grants the browser permission to autoplay subsequent tracks.

### 4. Crossfade Implementation
**Issue**: YouTube's IFrame doesn't natively support crossfading between two video IDs.
**Solution**: The `host.html` uses a custom volume ramp-down/ramp-up logic towards the end of a track to simulate a smoother transition, combined with pre-fetching/cueing logic.

## Common Fixes

### Python Service Connectivity
If search is failing, check if the microservice is running:
```bash
curl http://localhost:5001/health
```
If it's down, check the Node.js console for spawn errors related to `ytmusic_service.py`.

### Metadata Cache Issues
If BPM or Mood data is missing, check `metadata_cache.json`. If corrupted, delete it and restart the server to rebuild the cache from Last.fm and AcousticBrainz.

### Socket Sync
If the Guest UI isn't updating, check the browser console for Socket.io connection errors. Ensure the `PORT` in `.env` matches what the server is listening on.

## Related Documentation
- [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
- [ytmusicapi Documentation](https://ytmusicapi.readthedocs.io/)
