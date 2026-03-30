require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// ─── State (in-memory, resets on server restart) ─────────────────────────────
let spotifyTokens = { accessToken: null, refreshToken: null, expiresAt: 0 };
let queue = [];        // sorted by votes descending
let currentTrack = null;
let targetTrack = null;
let deviceId = null;   // Spotify Web Playback SDK device ID from host page
let lastTrackChange = 0; // Timestamp of last track change (debounce protection)
let activeHost = { socketId: null, hostId: null };
let recentlyPlayed = new Map(); // trackId -> timestamp of when it was played

const SEED_GENRES = ['pop', 'rock', 'electronic', 'hip-hop', 'jazz', 'ambient'];

const GENRE_PLAYLISTS = {
  'pop': '37i9dQZF1DWVlLVXKTOAYa',           // Pop Right Now
  'rock': '37i9dQZF1DWZryfp6NSvtz',          // All New Rock
  'electronic': '37i9dQZF1DX0BcQWzuB7ZO',   // Dance Hits
  'hip-hop': '37i9dQZF1DX48TTZL62Yht',       // Hip-Hop Favourites
  'jazz': '37i9dQZF1DWV7EzJMK2FUI',          // Jazz in the Background
  'ambient': '37i9dQZF1DX9c7yCloFHHL'        // New Ambient
};

function shuffleArray(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Fetch recommendations from Spotify seeded by current track or random genres
async function fetchSpotifyRecommendations(limit = 1) {
  try {
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);

    // Clean up old entries
    for (const [trackId, timestamp] of recentlyPlayed) {
      if (timestamp < thirtyMinutesAgo) {
        recentlyPlayed.delete(trackId);
      }
    }

    const excludeIds = new Set(
      [...queue.map(t => t.trackId), currentTrack?.trackId, targetTrack?.trackId].filter(Boolean)
    );

    // Also exclude recently played (within 30 minutes)
    for (const trackId of recentlyPlayed.keys()) {
      excludeIds.add(trackId);
    }

    const genres = shuffleArray(SEED_GENRES).slice(0, 1)[0];
    const query = `genre:${genres}`;
    const ccToken = await getClientCredentialsToken();
    const fetchLimit = Math.min(limit + excludeIds.size, 50);

    const { data } = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${ccToken}` },
      params: { q: query, type: 'track', limit: fetchLimit },
    });

    return data.tracks.items
      .filter(t => !excludeIds.has(t.id) && !(BLOCK_EXPLICIT && t.explicit))
      .slice(0, limit)
      .map(t => ({
        trackId: t.id,
        title: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        album: t.album.name,
        albumArt: t.album.images[1]?.url || t.album.images[0]?.url || null,
        explicit: t.explicit,
        uri: t.uri,
      }));
  } catch (err) {
    console.error('Failed to fetch recommendations:', err.message);
    return null;
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'http://127.0.0.1:3000/auth/callback';
const BLOCK_EXPLICIT = process.env.BLOCK_EXPLICIT === 'true';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-library-read',
].join(' ');

// ─── Spotify Token Helpers ────────────────────────────────────────────────────
const authHeader = () => ({
  Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
  'Content-Type': 'application/x-www-form-urlencoded',
});

async function refreshAccessToken() {
  if (!spotifyTokens.refreshToken) return null;
  const { data } = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({ grant_type: 'refresh_token', refresh_token: spotifyTokens.refreshToken }),
    { headers: authHeader() }
  );
  spotifyTokens.accessToken = data.access_token;
  spotifyTokens.expiresAt   = Date.now() + data.expires_in * 1000;
  return spotifyTokens.accessToken;
}

async function getToken() {
  if (!spotifyTokens.accessToken) return null;
  if (Date.now() > spotifyTokens.expiresAt - 60_000) return refreshAccessToken();
  return spotifyTokens.accessToken;
}

// Client credentials for search (no user auth required)
let clientCredentialsToken = null;
let clientCredentialsExpires = 0;

async function getClientCredentialsToken() {
  if (clientCredentialsToken && Date.now() < clientCredentialsExpires - 60_000) {
    return clientCredentialsToken;
  }
  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({ grant_type: 'client_credentials' }),
      { headers: authHeader() }
    );
    clientCredentialsToken = data.access_token;
    clientCredentialsExpires = Date.now() + data.expires_in * 1000;
    return clientCredentialsToken;
  } catch (err) {
    console.error('Client credentials error:', err.response?.data);
    return null;
  }
}

// ─── Queue Helpers ────────────────────────────────────────────────────────────
const sortQueue = () => queue.sort((a, b) => b.votes - a.votes || a.addedAt - b.addedAt);

function queueState() {
  return {
    queue: queue.map(item => ({ ...item, voters: Array.from(item.voters) })),
    currentTrack: currentTrack ? { 
      ...currentTrack, 
      voters: Array.from(currentTrack.voters),
      uri: `spotify:track:${currentTrack.trackId}`
    } : null,
    targetTrack: targetTrack ? {
      ...targetTrack,
      voters: Array.from(targetTrack.voters),
      uri: `spotify:track:${targetTrack.trackId}`
    } : null,
  };
}

function broadcast() {
  io.emit('queueUpdate', queueState());
}

function sanitizeTrack(track) {
  if (!track) return null;
  return {
    ...track,
    voters: Array.from(track.voters),
    uri: `spotify:track:${track.trackId}`,
  };
}

async function ensureQueueHasUpcomingTrack() {
  if (queue.length > 0) return false;
  try {
    const tracks = await fetchSpotifyRecommendations(1);
    if (tracks?.length) {
      const t = tracks[0];
      queue.push({
        id: 'fallback_' + uuidv4(),
        trackId: t.trackId,
        title: t.title,
        artist: t.artist,
        album: t.album,
        albumArt: t.albumArt,
        explicit: t.explicit,
        uri: t.uri,
        votes: 0,
        voters: new Set(),
        addedAt: Date.now(),
        isFallback: true,
      });
      return true;
    }
  } catch (err) {
    console.error('Failed to fetch recommendation for autoplay:', err.message);
  }
  return false;
}

function markTrackAsPlayed(trackId) {
  if (trackId) {
    recentlyPlayed.set(trackId, Date.now());
  }
}

let advanceInProgress = false;

async function advanceToNextTrack() {
  if (advanceInProgress) return sanitizeTrack(currentTrack);
  const now = Date.now();
  if (now - lastTrackChange < 3000) {
    return sanitizeTrack(currentTrack);
  }
  advanceInProgress = true;
  try {

  await ensureQueueHasUpcomingTrack();
  const next = queue.shift();
  if (next?.isFallback) {
    console.log('🎵 Queue empty - playing fallback:', next.title, '-', next.artist);
  }

  targetTrack = next;
  if (next?.trackId) {
    markTrackAsPlayed(next.trackId);
  }
  lastTrackChange = now;
  await ensureQueueHasUpcomingTrack();

  broadcast();
  return sanitizeTrack(next);
  } finally {
    advanceInProgress = false;
  }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  res.redirect('https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
  }));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/host.html?auth=error');
  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: authHeader() }
    );
    spotifyTokens.accessToken  = data.access_token;
    spotifyTokens.refreshToken = data.refresh_token;
    spotifyTokens.expiresAt    = Date.now() + data.expires_in * 1000;
    res.redirect('/host.html?auth=success');
  } catch (err) {
    console.error('Auth error:', err.response?.data);
    res.redirect('/host.html?auth=error');
  }
});

app.get('/auth/token', async (req, res) => {
  try {
    const token = await getToken();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ accessToken: token });
  } catch (err) {
    spotifyTokens = { accessToken: null, refreshToken: null, expiresAt: 0 };
    console.error('Token error:', err.response?.data || err.message);
    res.status(401).json({ error: 'Spotify authentication expired' });
  }
});

app.get('/auth/status', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ authenticated: !!token });
  } catch (err) {
    spotifyTokens = { accessToken: null, refreshToken: null, expiresAt: 0 };
    res.json({ authenticated: false });
  }
});

// ─── Admin Middleware ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ─── Search ───────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query required' });

  try {
    const queryLower = q.trim().toLowerCase();
    const isGenre = SEED_GENRES.includes(queryLower);
    const token = await getClientCredentialsToken();
    if (!token) return res.status(500).json({ error: 'Failed to authenticate with Spotify' });

    if (isGenre) {
      // Search for genre using Spotify's genre filter
      const searchUrl = `https://api.spotify.com/v1/search?q=genre:${encodeURIComponent(queryLower)}&type=track&limit=10`;
      const { data } = await axios.get(searchUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      let tracks = data.tracks.items;
      if (BLOCK_EXPLICIT) tracks = tracks.filter(t => !t.explicit);

      res.json(tracks.map(t => ({
        trackId:  t.id,
        title:    t.name,
        artist:   t.artists.map(a => a.name).join(', '),
        album:    t.album.name,
        albumArt: t.album.images[1]?.url || t.album.images[0]?.url || null,
        explicit: t.explicit,
        duration: t.duration_ms,
      })));
    } else {
      // Regular track search for non-genres
      const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`;
      const { data } = await axios.get(searchUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      let tracks = data.tracks.items;
      if (BLOCK_EXPLICIT) tracks = tracks.filter(t => !t.explicit);

      res.json(tracks.map(t => ({
        trackId:  t.id,
        title:    t.name,
        artist:   t.artists.map(a => a.name).join(', '),
        album:    t.album.name,
        albumArt: t.album.images[1]?.url || t.album.images[0]?.url || null,
        explicit: t.explicit,
        duration: t.duration_ms,
      })));
    }
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/suggestions', async (req, res) => {
  try {
    const genres = shuffleArray(SEED_GENRES).slice(0, 1)[0];
    const query = `genre:${genres}`;
    const ccToken = await getClientCredentialsToken();
    const { data } = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${ccToken}` },
      params: { q: query, type: 'track', limit: 9 },
    });
    const excludeIds = new Set([...queue.map(t => t.trackId), currentTrack?.trackId].filter(Boolean));
    const tracks = data.tracks.items
      .filter(t => !excludeIds.has(t.id) && !(BLOCK_EXPLICIT && t.explicit))
      .map(t => ({
        trackId: t.id,
        title: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        album: t.album.name,
        albumArt: t.album.images[1]?.url || t.album.images[0]?.url || null,
        explicit: t.explicit,
        uri: t.uri,
      }));
    res.json(tracks);
  } catch (err) {
    console.error('Suggestions error:', err.message);
    res.json([]);
  }
});

// ─── Queue ────────────────────────────────────────────────────────────────────
app.get('/api/queue', async (req, res) => {
  await ensureQueueHasUpcomingTrack();
  res.json(queueState());
});

app.post('/api/queue', (req, res) => {
  const { trackId, title, artist, album, albumArt, explicit } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });
  if (BLOCK_EXPLICIT && explicit) return res.status(400).json({ error: 'Explicit songs are disabled' });
  if (queue.find(i => i.trackId === trackId)) return res.status(409).json({ error: 'Song already in queue' });

  const item = {
    id: uuidv4(), trackId, title, artist, album, albumArt, explicit,
    votes: 1,
    voters: new Set([req.body.voterId || 'anon']),
    addedAt: Date.now(),
  };
  queue.push(item);
  sortQueue();
  broadcast();
  res.json({ success: true, item: { ...item, voters: Array.from(item.voters) } });
});

// ─── Voting ───────────────────────────────────────────────────────────────────
app.post('/api/vote/:id', (req, res) => {
  const item = queue.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const { voterId } = req.body;
  if (!voterId) return res.status(400).json({ error: 'voterId required' });
  if (item.voters.has(voterId)) return res.status(409).json({ error: 'Already voted' });

  item.voters.add(voterId);
  item.votes++;
  sortQueue();
  broadcast();
  res.json({ success: true, votes: item.votes });
});

// ─── Admin: Remove Song ───────────────────────────────────────────────────────
app.delete('/api/queue/:id', requireAdmin, async (req, res) => {
  const before = queue.length;
  queue = queue.filter(i => i.id !== req.params.id);
  if (queue.length === before) return res.status(404).json({ error: 'Not found' });
  await ensureQueueHasUpcomingTrack();
  broadcast();
  res.json({ success: true });
});

// ─── Admin: Skip ──────────────────────────────────────────────────────────────
// ─── Admin: Skip ──────────────────────────────────────────────────────────────
app.post('/api/skip', requireAdmin, async (req, res) => {
  try {
    lastTrackChange = 0;
    const track = await advanceToNextTrack();
    res.json({ success: true, track });
  } catch (err) {
    console.error('Skip error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to skip track' });
  }
});

// ─── Admin: Clear Queue ───────────────────────────────────────────────────────
app.delete('/api/queue', requireAdmin, async (req, res) => {
  queue = [];
  targetTrack = null;
  await ensureQueueHasUpcomingTrack();
  broadcast();
  res.json({ success: true });
});

// ─── Admin: Verify auth ───────────────────────────────────────────────────────
app.post('/api/auth/verify', requireAdmin, (req, res) => {
  res.json({ success: true });
});

// ─── Host: Get current playback state ─────────────────────────────────────────
app.get('/api/playback', async (req, res) => {
  try {
    const token = await getToken();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    
    const { data } = await axios.get('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` },
    });
    
    if (!data) return res.json({ isPlaying: false, position: 0, duration: 0 });
    
    res.json({
      isPlaying: data.is_playing,
      position: data.progress_ms,
      duration: data.item?.duration_ms || 0,
      trackName: data.item?.name,
      trackId: data.item?.id,
    });
  } catch (err) {
    console.error('Playback state error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get playback state' });
  }
});

// ─── Host: Control playback (play/pause) ──────────────────────────────────────
app.post('/api/playback/:action', async (req, res) => {
  const { action } = req.params;
  if (!['play', 'pause'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  
  let token = null;
  try {
    token = await getToken();
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    
    // Build URL with device_id if available
    let url = `https://api.spotify.com/v1/me/player/${action}`;
    if (deviceId) {
      url += `?device_id=${deviceId}`;
    }
    
    await axios.put(
      url,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    res.json({ success: true });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error(`Playback ${action} error:`, errorMsg);
    
    // If no active device, try to transfer playback to our device first
    if (errorMsg.includes('No active device') && deviceId) {
      try {
        await axios.put(
          'https://api.spotify.com/v1/me/player',
          { device_ids: [deviceId], play: action === 'play' },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        res.json({ success: true, note: 'Transferred to jukebox device' });
        return;
      } catch (transferErr) {
        console.error('Device transfer error:', transferErr.response?.data || transferErr.message);
      }
    }
    
    res.status(500).json({ error: errorMsg || 'Failed to control playback' });
  }
});

// ─── Host: Register Device ────────────────────────────────────────────────────
app.post('/api/device', (req, res) => {
  const { hostId } = req.body;
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  if (activeHost.hostId && activeHost.hostId !== hostId) {
    return res.status(409).json({ error: 'Another host session is active' });
  }

  activeHost.hostId = hostId;
  deviceId = req.body.deviceId;
  console.log('Host device registered:', deviceId);
  res.json({ success: true });
});

app.post('/api/host/ack', async (req, res) => {
  const { trackId, adoptTarget = false, naturalAdvance = false } = req.body || {};
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  if (naturalAdvance) {
    const queuedTrack = queue.find(item => item.trackId === trackId);
    if (queuedTrack) {
      currentTrack = queuedTrack;
      targetTrack = queuedTrack;
      queue = queue.filter(item => item.trackId !== trackId);
      await ensureQueueHasUpcomingTrack();
      broadcast();
      return res.json({ success: true, advanced: true });
    }
  }

  if (targetTrack && targetTrack.trackId === trackId) {
    currentTrack = targetTrack;
  } else if (currentTrack && currentTrack.trackId === trackId) {
    // Already in sync.
  } else {
    const queuedTrack = queue.find(item => item.trackId === trackId);
    if (queuedTrack) {
      currentTrack = queuedTrack;
      queue = queue.filter(item => item.trackId !== trackId);
    } else {
      currentTrack = {
        id: `ack_${uuidv4()}`,
        trackId,
        title: req.body.title || 'Unknown track',
        artist: req.body.artist || '',
        album: req.body.album || '',
        albumArt: req.body.albumArt || null,
        explicit: false,
        votes: 0,
        voters: new Set(),
        addedAt: Date.now(),
        isFallback: false,
      };
    }
    if (adoptTarget || !targetTrack) {
      targetTrack = currentTrack;
    }
  }

  broadcast();
  res.json({ success: true });
});

// ─── Background sync: Verify server state matches Spotify reality ─────────────
let lastServerCorrection = 0;

setInterval(async () => {
  // Don't correct more than once every 30 seconds (cooldown)
  if (Date.now() - lastServerCorrection < 30000) return;
  if (!targetTrack || !spotifyTokens.accessToken) return;
  
  try {
    const token = await getToken();
    if (!token) return;
    
    // Check what Spotify is actually playing
    const { data } = await axios.get('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` },
    });
    
    if (!data || !data.item) return;
    
    const actualTrackId = data.item.id;
    const serverTrackId = targetTrack.trackId;
    
    // Only correct if Spotify has been playing something different for a while
    // AND it's not paused/stopped
    if (actualTrackId !== serverTrackId && data.is_playing) {
      
      // Check if it's a user-requested song (in queue)
      const queueTrack = queue.find(t => t.trackId === actualTrackId);
      if (queueTrack) {
        console.log('-> Found in queue, updating current track only');
        currentTrack = queueTrack;
        queue = queue.filter(t => t.id !== queueTrack.id);
        await ensureQueueHasUpcomingTrack();
        broadcast();
        lastServerCorrection = Date.now();
      }
      // Don't auto-correct for unknown tracks - let the host handle it
    }
  } catch (err) {
    // Silent fail
  }
}, 10000); // Check every 10 seconds

// ─── Host: Request Next Track ─────────────────────────────────────────────────
app.post('/api/next', async (req, res) => {
  try {
    const track = await advanceToNextTrack();
    res.json({ track });
  } catch (err) {
    console.error('Next error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get next track' });
  }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  ensureQueueHasUpcomingTrack()
    .then(() => socket.emit('queueUpdate', queueState()))
    .catch(() => socket.emit('queueUpdate', queueState()));

  socket.on('registerHost', ({ hostId } = {}) => {
    if (!hostId) {
      socket.emit('hostRejected', { reason: 'Missing host ID' });
      return;
    }

    const noActiveHost = !activeHost.socketId || !activeHost.hostId;
    const sameHost = activeHost.hostId === hostId;
    const sameSocket = activeHost.socketId === socket.id;

    if (noActiveHost || sameHost || sameSocket) {
      activeHost = { socketId: socket.id, hostId };
      socket.emit('hostAccepted', { hostId });
      return;
    }

    socket.emit('hostRejected', { reason: 'Another host page is already active' });
  });

  socket.on('disconnect', () => {
    if (activeHost.socketId === socket.id) {
      activeHost = { socketId: null, hostId: null };
      deviceId = null;
      targetTrack = null;
      console.log('Host session released');
    }
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`🎵 Jukebox server running → http://${HOST}:${PORT}`));
