# 🎵 YouTube Bar Jukebox

A real-time, collaborative jukebox system designed for bars. Guests scan a QR code, search for music from YouTube Music, add tracks to a shared queue, and vote for what plays next. When the queue is empty, the **Autonomous Resident DJ** takes over using smart discovery logic.

---

## Core Features

- **Guest UI** (`/guest.html`): Mobile-friendly interface for searching, voting, and adding songs.
- **Admin Panel** (`/admin.html`): Full control over the queue, pool management, and discovery settings.
- **Host Player** (`/host.html`): The central player using the YouTube IFrame API with crossfade support.
- **Autonomous Resident DJ**: Smart-fill logic that discovers similar music when the queue is low.
- **Hybrid Metadata**: Enriches tracks with BPM, Mood, and Danceability using AcousticBrainz and Last.fm.
- **Content Filtering**: Filters for bar-appropriate music (Western/Latin script) and blocks explicit content.

---

## Setup & Installation

### 1. Prerequisites
- Node.js (v16+)
- Python 3.x (for the YouTube Music microservice)
- YouTube Data API Key (v3)

### 2. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` and fill in:
- `YOUTUBE_API_KEY` — your Google Cloud YouTube API key.
- `ADMIN_PASSWORD` — password for the admin panel.
- `BLOCK_EXPLICIT` — `true` to filter explicit songs.
- `LASTFM_API_KEY` — (Optional) for enhanced track discovery and metadata.

### 3. Install & Run
```bash
npm install
pip install -r requirements.txt
npm start
```
The server will automatically start the Python microservice (`ytmusic_service.py`) on port 5001.

---

## How It Works

### Queue & Voting
- Songs are ordered by **vote count** (highest first).
- Guests can vote once per song (tracked via localStorage).
- The Host Player automatically plays the next song when the current one ends.

### Autonomous Resident DJ (Smart-Fill)
When the queue is empty, the system pulls tracks from a "Pool". The pool is populated via:
- **Curated Charts**: Top tracks from YouTube Music.
- **Mood Playlists**: "Party", "Chill", "Rock", etc.
- **Artist Seeds**: Similar artists based on your configuration.
- **Rolling Discovery**: Automatically discovers and adds similar tracks based on what's playing.

### Admin Controls
- **Queue Management**: Skip, remove, or clear the queue.
- **Pool Management**: Upload CSV playlists, add artist seeds, or toggle discovery modes.
- **Discovery Progress**: Real-time progress bar for background song discovery.

---

## Architecture

```
[Guest phones] ──scan QR──▶ [guest.html]
                                │ search, vote, add
                                ▼
                          [server.js] (Node.js) ◀──▶ [ytmusic_service.py] (Python)
                                │ (Socket.io updates)
                                ▼
                          [host.html] ──▶ [YouTube IFrame Player]
                          (Plays audio via YouTube)
```

---

## Troubleshooting

**YouTube Error 150**
→ Some videos have embedding disabled. The system is designed to skip these or attempt to resolve an alternate "Audio Track Version" (ATV).

**Python Service Not Starting**
→ Ensure Python 3 is in your PATH and `ytmusicapi` is installed. Check logs for port 5001 conflicts.

**Search Returns No Results**
→ Check your `YOUTUBE_API_KEY` and ensure the Python microservice is running.

