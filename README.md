# 🎵 Bar Jukebox

A real-time jukebox system for bars. Guests scan a QR code, search songs, add them to a shared queue, and vote for what plays next. Built on Node.js + Socket.io + Spotify Web API.

---

## Pages

| Page | URL | Who uses it |
|---|---|---|
| Guest UI | `/guest.html` | Bar patrons (scan QR) |
| Admin Panel | `/admin.html` | You — queue management, skip, remove |
| Host Player | `/host.html` | Your bar's PC/phone — plays the music |

---

## Setup (Step by Step)

### 1. Create a Spotify App

1. Go to https://developer.spotify.com/dashboard
2. Click **Create App**
3. Name it anything (e.g. "Bar Jukebox")
4. Set **Redirect URI** to: `http://127.0.0.1:3000/auth/callback` (Spotify doesn't allow 'localhost') (for local) or your production URL
5. Enable **Web API** and **Web Playback SDK**
6. Copy your **Client ID** and **Client Secret**

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `SPOTIFY_CLIENT_ID` — from your Spotify app
- `SPOTIFY_CLIENT_SECRET` — from your Spotify app
- `REDIRECT_URI` — must match what you set in Spotify dashboard
- `ADMIN_PASSWORD` — password for your admin panel
- `BLOCK_EXPLICIT` — `true` to filter explicit songs

### 3. Install & Run

```bash
npm install
npm start
```

Server starts at http://localhost:3000

### 4. First Use

1. Open **http://localhost:3000/host.html** on your bar device
2. Click **Connect Spotify** — log in with your Spotify Premium account
3. The player is now ready and will auto-play songs from the queue
4. Open **http://localhost:3000/admin.html** — your password is `ADMIN_PASSWORD` from `.env`
5. Share `http://localhost:3000/guest.html` via QR code at each table

---

## How It Works

### Queue Logic
- Songs are ordered by **vote count** (highest first)
- When a track ends, the server automatically pulls the next song and plays it via Spotify API
- If the queue is empty, the host player polls every 5 seconds waiting for guests to add songs
- Guests can only vote once per song (tracked per device via localStorage)

### Admin Controls
- **Remove songs** — click ✕ next to any song in queue
- **Skip** — force play the next song immediately
- **Clear all** — empty the entire queue

### Blocking Explicit Songs
Set `BLOCK_EXPLICIT=true` in `.env`. This filters explicit tracks from search results AND rejects them if added via API.

---

## Deploying to Production

**Recommended stack:** Render for the first public version.

### Render

1. Push this project to GitHub
2. Create a new Render Web Service from the repo
3. Render can use the included `render.yaml`, or you can set these manually:
   - Build command: `npm install`
   - Start command: `npm start`
4. Set environment variables in Render:
   - `HOST=0.0.0.0`
   - `SPOTIFY_CLIENT_ID=...`
   - `SPOTIFY_CLIENT_SECRET=...`
   - `REDIRECT_URI=https://your-domain/auth/callback`
   - `ADMIN_PASSWORD=...`
   - `BLOCK_EXPLICIT=false` or `true`
5. In Spotify Developer Dashboard, add the same production callback URL to your app

Once deployed, your pages will be:
- `https://your-domain/host.html`
- `https://your-domain/admin.html`
- `https://your-domain/guest.html`

### Updating The Live Version

The easiest workflow is:

1. Keep the code in GitHub
2. Connect Render to that repo
3. Every time you push a change, Render redeploys automatically

So yes, modifying the online version is easy as long as you use Git-based deploys.

### QR Code
Once live, go to your admin panel → Settings to get the guest URL. 
Use any free QR generator (qr-code-generator.com, etc.) to create a QR code pointing to `/guest.html`.
Print and laminate one per table.

---

## Architecture

```
[Guest phones] ──scan QR──▶ [guest.html]
                                │ search, vote, add
                                ▼
                          [server.js]  ◀──── Socket.io (real-time updates to everyone)
                          Express + Socket.io
                                │ play command via Spotify API
                                ▼
                          [host.html]  ──▶  [Spotify Premium Account]
                          Spotify Web         plays through your speakers
                          Playback SDK
                          
[Admin phone/PC] ──────▶ [admin.html]  ──▶  [server.js]  (remove, skip, clear)
```

---

## Troubleshooting

**"Spotify Premium required" error**
→ The Spotify account used to log in on the host page must be Premium.

**Songs not playing after auth**
→ Make sure the host page stays open and active. The browser must remain open.

**Search returns no results**
→ Check that the host page has completed Spotify auth first. Search goes through the server which needs a valid token.

**QR code not working for guests**
→ Make sure guests and the server are on the same network, OR deploy to a public URL.

**Queue not updating live**
→ Check browser console for Socket.io connection errors. Make sure server is running.
