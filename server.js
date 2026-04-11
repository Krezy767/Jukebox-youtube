require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// ─── State (in-memory, resets on server restart) ─────────────────────────────
let queue = [];
let currentTrack = null;
let targetTrack = null;
let lastTrackChange = 0;
let activeHost = { socketId: null, hostId: null };
let recentlyPlayed = new Map(); // trackId -> timestamp of when it was played
let recentArtists  = [];        // last 3 artist names (normalized), for spread enforcement
const viewCountCache = new Map(); // trackId -> YouTube view count, persists across rebuilds
const lastFmCache    = new Map(); // trackId -> { energy, danceability }, persists across rebuilds

// ─── Pool State ───────────────────────────────────────────────────────────────
let poolMode = 'both'; // 'playlist' | 'discovery' | 'both'
let artistDiscoveryRatio = 50; // 0 = all discovery (charts/genre), 100 = all artist seeds
let artistSeeds = []; // [{ channelId, artistName }]
let csvPlaylists = []; // [{ name, addedAt, tracks: [...] }]
let activeMoodIds = new Set(); // mood IDs currently active
let poolSources = {
  csv:    [],
  genre:  [],
  charts: [],
  moods:  [],
  artist: [],
  pinned: [],
};

// ─── Available Moods ──────────────────────────────────────────────────────────
const AVAILABLE_MOODS = [
  { id: 'party',     name: 'Party',      emoji: '🎉', query: 'Party Hits' },
  { id: 'chill',     name: 'Chill',      emoji: '😌', query: 'Chill Hits' },
  { id: 'feelgood',  name: 'Feel Good',  emoji: '😊', query: 'Feel Good Music' },
  { id: 'workout',   name: 'Workout',    emoji: '💪', query: 'Workout Music' },
  { id: 'hiphop',    name: 'Hip-Hop',    emoji: '🎤', query: 'Hip Hop Hits' },
  { id: 'rnb',       name: 'R&B',        emoji: '❤️', query: 'R&B Hits' },
  { id: 'pop',       name: 'Pop',        emoji: '⭐', query: 'Pop Hits' },
  { id: 'rock',      name: 'Rock',       emoji: '🎸', query: 'Rock Hits' },
  { id: 'dance',     name: 'Dance',      emoji: '🕺', query: 'Dance Hits' },
  { id: 'throwback', name: 'Throwback',  emoji: '⏮️', query: 'Throwback Hits' },
  { id: 'summer',    name: 'Summer',     emoji: '☀️', query: 'Summer Hits' },
  { id: 'romance',   name: 'Romance',    emoji: '💕', query: 'Romance Music' },
  { id: 'latin',     name: 'Latin',      emoji: '🌶️', query: 'Reggaeton Hits' },
  { id: 'focus',     name: 'Focus',      emoji: '🎯', query: 'Focus Music' },
  { id: 'jazz',      name: 'Jazz',       emoji: '🎷', query: 'Jazz Hits' },
  { id: 'house',      name: 'Deep House',    emoji: '🎛️', query: 'Deep House Music' },
  { id: 'organichouse', name: 'Organic House', emoji: '🌅', query: 'Organic Deep House Melodic' },
  { id: 'afrohouse',   name: 'Afro House',    emoji: '🥁', query: 'Afro House Music' },
  { id: 'jackinhouse',  name: 'Jackin\' House',   emoji: '📼', query: 'Jackin House Lo-Fi' },
  { id: 'croatiantrash', name: 'Croatian Trash', emoji: '🇭🇷', query: 'Hrvatska eurodance 90s' },
];

// ─── Config ───────────────────────────────────────────────────────────────────
const YOUTUBE_API_KEY    = process.env.YOUTUBE_API_KEY || 'YOUR_YOUTUBE_API_KEY_HERE';
const LASTFM_API_KEY     = process.env.LASTFM_API_KEY  || '';
const MAX_TRACK_DURATION_MS = 10 * 60 * 1000; // 10 minutes — filters out compilations/streams
const MIN_TRACK_DURATION_MS = 90 * 1000;      // 90 seconds — filters out Shorts
const BLOCK_EXPLICIT  = process.env.BLOCK_EXPLICIT === 'true';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || 'changeme';

const YT_API = 'https://www.googleapis.com/youtube/v3';

// ─── YouTube Helpers ──────────────────────────────────────────────────────────
function parseISO8601Duration(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = parseInt(match[1] || 0);
  const m = parseInt(match[2] || 0);
  const s = parseInt(match[3] || 0);
  return (h * 3600 + m * 60 + s) * 1000;
}

async function ytSearch(query, maxResults = 15) {
  const { data } = await axios.get(`${YT_API}/search`, {
    params: {
      part: 'snippet',
      type: 'video',
      videoCategoryId: '10', // Music category
      videoEmbeddable: 'true',
      regionCode: 'US',
      relevanceLanguage: 'en',
      q: query,
      maxResults,
      key: YOUTUBE_API_KEY,
    },
  });
  return data.items || [];
}

async function ytVideoDetails(videoIds) {
  if (!videoIds.length) return [];
  const { data } = await axios.get(`${YT_API}/videos`, {
    params: {
      part: 'snippet,contentDetails,status',
      id: videoIds.join(','),
      key: YOUTUBE_API_KEY,
    },
  });
  // Filter out videos that can't be embedded — they'll always error 101/150 in IFrame player
  return (data.items || []).filter(item => item.status?.embeddable !== false);
}

function isValidSongDuration(durationMs) {
  return durationMs >= MIN_TRACK_DURATION_MS && durationMs <= MAX_TRACK_DURATION_MS;
}

// Score a raw API item by how "audio-only / YouTube Music-like" it is.
// Topic channels  (e.g. "The Weeknd - Topic") are the exact source YouTube Music uses.
// Returns: 2 = Topic channel audio, 1 = official audio/lyric, 0 = neutral, -1 = music video
function scoreYtItem(item) {
  const title   = (item.snippet?.title   || '').toLowerCase();
  const channel = (item.snippet?.channelTitle || '');
  if (channel.endsWith('- Topic'))                                          return 2;
  if (title.includes('official audio') || title.includes('(audio)') ||
      title.includes('lyric') || title.includes('lyrics'))                  return 1;
  if (title.includes('official video') || title.includes('official music video') ||
      title.includes('(mv)') || title.includes('music video'))              return -1;
  return 0;
}

// Clean up Topic-channel titles: "Song Name" stays, "Artist - Song" stays.
// Topic channels already upload clean titles, so we just strip trailing " (Official Audio)" etc.
function cleanTitle(raw) {
  return raw
    .replace(/\s*[\[(]official\s*(music\s*)?(video|audio|lyric(s)?|visualizer)[\])]/gi, '')
    .replace(/\s*[\[(](lyrics?|audio|video|mv|visualizer)[\])]/gi, '')
    .trim();
}

function mapVideoItemToTrack(item) {
  const snippet  = item.snippet || {};
  const duration = parseISO8601Duration(item.contentDetails?.duration);
  const channel  = snippet.channelTitle || 'Unknown';
  // For Topic channels strip the trailing " - Topic" to get the real artist name
  const artist   = channel.endsWith('- Topic') ? channel.slice(0, -8).trim() : channel;
  return {
    trackId:  item.id,
    title:    cleanTitle(snippet.title || 'Unknown'),
    artist,
    album:    '',
    albumArt: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
    explicit: false,
    duration,
    popularity: null,
    isTopicAudio: channel.endsWith('- Topic'),
  };
}

// ─── Pool Helpers ─────────────────────────────────────────────────────────────
function rebuildCsvSource() {
  const seen = new Set();
  poolSources.csv = [];
  for (const playlist of csvPlaylists) {
    for (const track of playlist.tracks) {
      if (!seen.has(track.trackId)) {
        seen.add(track.trackId);
        poolSources.csv.push(track);
      }
    }
  }
}

function mergePool() {
  const seen = new Set();
  const merged = [];
  const includeCsv       = poolMode === 'playlist' || poolMode === 'both';
  const includeDiscovery = poolMode === 'discovery' || poolMode === 'both';

  if (includeCsv) {
    for (const track of poolSources.csv) {
      if (!seen.has(track.trackId)) {
        seen.add(track.trackId);
        merged.push({ ...track, source: 'csv' });
      }
    }
  }

  if (includeDiscovery) {
    // Pinned tracks always included regardless of ratio
    for (const track of poolSources.pinned) {
      if (!seen.has(track.trackId)) {
        seen.add(track.trackId);
        merged.push({ ...track, source: 'pinned' });
      }
    }

    // Include ALL artist and discovery tracks — no trimming.
    // The ratio is enforced at pick time in fetchRecommendations via weighted
    // bucket selection, so pool size is never sacrificed for ratio accuracy.
    const discoveryTracks = activeMoodIds.size > 0
      ? poolSources.moods.map(t  => ({ ...t, source: 'moods'  }))
      : poolSources.charts.map(t => ({ ...t, source: 'charts' }));

    for (const track of [...poolSources.artist.map(t => ({ ...t, source: 'artist' })), ...discoveryTracks]) {
      if (!seen.has(track.trackId)) {
        seen.add(track.trackId);
        merged.push({ ...track });
      }
    }
  }

  playlistCache.bar = shuffleArray(merged);
  suggestionRotationIndex = 0;
  console.log(`✓ Pool merged: ${merged.length} tracks [mode: ${poolMode}] (csv: ${poolSources.csv.length}, charts: ${poolSources.charts.length}, genre: ${poolSources.genre.length}, artist: ${poolSources.artist.length}, pinned: ${poolSources.pinned.length})`);
  // Kick off async queue pruning — don't await, mergePool is sync
  pruneQueueToPool().catch(() => {});
}

// Remove auto-queued fallback tracks that no longer belong in the current pool.
// Patron-requested tracks (votes >= 1, non-fallback id) are never touched.
async function pruneQueueToPool() {
  const poolSet = new Set(playlistCache.bar.map(t => t.trackId));
  const before = queue.length;
  queue = queue.filter(item => !item.id.startsWith('fallback_') || poolSet.has(item.trackId));
  if (queue.length < before) {
    console.log(`✓ Pruned ${before - queue.length} stale fallback track(s) from queue after pool rebuild`);
    await ensureQueueHasUpcomingTrack();
    broadcast();
  }
}

function shuffleArray(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ─── Smart Recommendation Scoring ────────────────────────────────────────────
// Energy tier derived from mood/source — no external API needed.
// Used to avoid jarring energy jumps between autoplay tracks.
const SOURCE_ENERGY = {
  workout: 3, party: 3, dance: 3, hiphop: 3, afrohouse: 3, jackinhouse: 3,
  pop: 2, rock: 2, latin: 2, rnb: 2, house: 2, organichouse: 2,
  throwback: 1, summer: 1, feelgood: 1,
  chill: 0, focus: 0, jazz: 0, romance: 0,
  // Non-mood sources get a neutral mid-tier
  charts: 2, artist: 2, csv: 2, pinned: 2, genre: 2, moods: 2,
};

function getEnergyTier(track) {
  return SOURCE_ENERGY[track?.source] ?? 2;
}

async function fetchRecommendations(limit = 1) {
  try {
    const now = Date.now();
    const thirtyMinutesAgo = now - (30 * 60 * 1000);
    for (const [trackId, timestamp] of recentlyPlayed) {
      if (timestamp < thirtyMinutesAgo) recentlyPlayed.delete(trackId);
    }
    const excludeIds = new Set(
      [...queue.map(t => t.trackId), currentTrack?.trackId, targetTrack?.trackId].filter(Boolean)
    );
    for (const trackId of recentlyPlayed.keys()) excludeIds.add(trackId);

    const pool = playlistCache.bar;
    if (!pool.length) return null;

    const allCandidates = pool.filter(t => !excludeIds.has(t.trackId));
    if (!allCandidates.length) return null;

    // Enforce artist/discovery ratio via weighted bucket selection.
    // Split into artist vs discovery buckets, pick bucket probabilistically —
    // ratio is respected without ever shrinking the pool.
    const artistCandidates    = allCandidates.filter(t => t.source === 'artist');
    const discoveryCandidates = allCandidates.filter(t => t.source !== 'artist');

    let candidates;
    if (artistCandidates.length === 0 || artistDiscoveryRatio === 0) {
      candidates = discoveryCandidates;
    } else if (discoveryCandidates.length === 0 || artistDiscoveryRatio === 100) {
      candidates = artistCandidates;
    } else {
      candidates = Math.random() < (artistDiscoveryRatio / 100)
        ? artistCandidates
        : discoveryCandidates;
    }
    if (!candidates.length) candidates = allCandidates; // fallback if chosen bucket exhausted

    // Derive current energy — prefer Last.fm score (0–1), fall back to source tier (0–1)
    const currentPoolTrack = currentTrack
      ? pool.find(t => t.trackId === currentTrack.trackId)
      : null;
    const currentEnergy = currentPoolTrack?.lfmEnergy ?? (getEnergyTier(currentPoolTrack) / 3);

    // Score each candidate
    const scores = candidates.map(track => {
      let score = 1.0;

      // Popularity: log scale so 100M views isn't absurdly dominant over 1M
      if (track.viewCount != null && track.viewCount > 0) {
        const pop = Math.min(1, Math.log10(track.viewCount + 1) / 8);
        score *= (0.4 + 0.6 * pop); // 40% base floor so unpopular tracks still play
      }

      // Energy continuity: use Last.fm 0–1 score when available, else source tier
      const trackEnergy = track.lfmEnergy ?? (getEnergyTier(track) / 3);
      const energyDiff  = Math.abs(trackEnergy - currentEnergy);
      if      (energyDiff > 0.5)  score *= 0.2; // big jump (e.g. banger → ambient)
      else if (energyDiff > 0.25) score *= 0.6; // medium jump

      // Danceability bonus: bar context — danceable tracks slightly preferred
      if (track.lfmDance != null) {
        score *= (0.7 + 0.3 * track.lfmDance); // 70% base + up to 30% bonus
      }

      // Artist spread: same artist as last track = hard exclude, recent = soft penalty
      const artist = track.artist.toLowerCase().trim();
      if (recentArtists[0] === artist)                  score = 0;
      else if (recentArtists.slice(1).includes(artist)) score *= 0.15;

      return Math.max(0, score);
    });

    // Weighted random selection — avoids always picking the single top-scored track
    const results = [];
    const used    = new Set();

    for (let pick = 0; pick < limit; pick++) {
      const total = scores.reduce((sum, s, i) => used.has(i) ? sum : sum + s, 0);
      if (total === 0) {
        // All candidates scored 0 (e.g. tiny pool, all same artist) — pure random fallback
        const remaining = candidates.filter((_, i) => !used.has(i));
        if (remaining.length) results.push(remaining[Math.floor(Math.random() * remaining.length)]);
        break;
      }
      let r = Math.random() * total;
      for (let i = 0; i < candidates.length; i++) {
        if (used.has(i)) continue;
        r -= scores[i];
        if (r <= 0) { results.push(candidates[i]); used.add(i); break; }
      }
    }

    return results.length > 0 ? results : null;
  } catch (err) {
    console.error('Failed to fetch recommendations:', err.message);
    return null;
  }
}

// ─── Playlist Cache ───────────────────────────────────────────────────────────
let playlistCache = { bar: [] };
let suggestionRotationIndex = 0;

// ─── YouTube Music Python microservice ────────────────────────────────────────
const YTMUSIC_SERVICE_PORT = process.env.YTMUSIC_SERVICE_PORT || 5001;
const YTMUSIC_SERVICE_URL  = `http://127.0.0.1:${YTMUSIC_SERVICE_PORT}`;
let ytmusicReady    = false;
let ytmusicProcess  = null;

async function startYTMusicService() {
  return new Promise((resolve) => {
    const pythonCmd  = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = path.join(__dirname, 'ytmusic_service.py');

    ytmusicProcess = spawn(pythonCmd, [scriptPath, String(YTMUSIC_SERVICE_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ytmusicProcess.stdout.on('data', d => process.stdout.write(`[ytmusic] ${d}`));
    ytmusicProcess.stderr.on('data', d => process.stderr.write(`[ytmusic] ${d}`));

    ytmusicProcess.on('exit', (code) => {
      console.warn(`[ytmusic] Service exited with code ${code}`);
      ytmusicReady = false;
    });

    // Poll for health — give it up to 20 seconds to start
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        await axios.get(`${YTMUSIC_SERVICE_URL}/health`, { timeout: 2000 });
        clearInterval(poll);
        ytmusicReady = true;
        console.log('✓ YouTube Music Python service ready');
        resolve(true);
      } catch {
        if (attempts >= 20) {
          clearInterval(poll);
          console.warn('⚠ YouTube Music Python service failed to start after 20s');
          resolve(false);
        }
      }
    }, 1000);
  });
}

// Map a song from the Python service to our internal track format.
// Python service returns: { videoId, title, artist, album, albumArt, duration (seconds), videoType }
function mapYtmSongToTrack(song) {
  return {
    trackId:     song.videoId,
    title:       song.title    || 'Unknown',
    artist:      song.artist   || 'Unknown',
    album:       song.album    || '',
    albumArt:    song.albumArt || null,
    explicit:    false,
    duration:    song.duration ? song.duration * 1000 : 0, // seconds → ms
    popularity:  null,
    videoType:   song.videoType || '',
    isTopicAudio: song.videoType === 'MUSIC_VIDEO_TYPE_ATV',
  };
}

// ─── Content filter ──────────────────────────────────────────────────────────
// Filters out non-English/non-Western songs that slip through GL=US region pinning.
// ── Pattern filters — each derived from real pool examples ───────────────────
const NON_LATIN_RE  = /[\u0370-\uFFFF]/;  // non-Latin scripts (Greek+, Cyrillic, Arabic, Hindi, CJK…) — allows accented Latin like é ñ ü
const FILM_SONG_RE      = /\(from\s+["'"]/i;             // "(From "Movie")" — Indian film music
const BAD_VERSION_RE    = /\b(karaoke|instrumental|cover version|tribute to|originally (performed|by))\b/i;

// Romanized Arabic words that appear in song titles
const ARABIC_TITLE_RE = /\b(habibi|habibti|yalla|wallah|inshallah|khalas|albi|mabrook|mashallah|ya\s+habibi|ana\s+mish|wala[hy]|enta|enti|ya\s+leil|ya\s+alb)\b/i;

// Romanized South Asian (Hindi/Urdu/Punjabi/Sinhala) words common in song titles.
// Words chosen because they are near-exclusively South Asian in a music context.
const SOUTH_ASIAN_TITLE_RE = /\b(ishq|mohabbat|pyaar?|zindagi|dilbar|tujh(se|e)?|sajna|sanam|naagin|patola|bhangra|dhol|jatta|balle|nachna|nachle|vekhna|lagdi|akh\s+lad|bol\s+do|tere\s+bin|tu\s+hi|kuch\s+kuch|desi\s+girl|soni\s+de|sandamali|adaraya|obata|sinhala)\b/i;

// K-pop and wider East Asian pop acts — matched against artist name.
// Using artist rather than title because many songs have English titles (e.g. "Dynamite", "Butter", "Soda Pop").
const KPOP_ARTISTS = new Set([
  // 1st–3rd gen K-pop
  'bts','blackpink','exo','twice','nct','nct 127','nct dream','wayv',
  'stray kids','itzy','aespa','newjeans','(g)i-dle','enhypen','txt',
  'tomorrow x together','monsta x','got7','shinee','bigbang','2ne1',
  'iu','ive','le sserafim','seventeen','ateez','nmixx','red velvet',
  'super junior','girls generation','snsd','mamamoo','winner','ikon',
  'the boyz','pentagon','sf9','day6','btob','astro','sunmi','chungha',
  'hwasa','hyuna','somi','zerobaseone','tws','kiss of life','triples',
  // 4th gen / newer
  'boynextdoor','riize','illit','fantasy boys','nowadays','hearts2hearts',
  'cravity','drippin','ghost9','oneus','onewe','victon','verivery',
  'kingdom','treasure','babymetal','xg','kep1er','weeekly','rocket punch',
  // J-pop / C-pop crossovers that surface in English searches
  'yoasobi','ado','kenshi yonezu','fujii kaze','official hige dandism','king gnu',
  'saja boys',
]);

// Non-Western artists whose names/titles are fully Latin-script (can't be caught by script check).
// Extend whenever a specific artist is reported — the SOUTH_ASIAN_TITLE_RE handles most cases.
const BLOCKED_ARTISTS = new Set([
  'sujallkxattri','pratigya',  // Indian
  'shan putha',                 // Sri Lankan
]);

// Specific titles manually flagged — last resort for songs that pass all regex/set checks
const BLOCKED_TITLES = new Set([
  'yalla',      // Arabic (also caught by ARABIC_TITLE_RE)
  'sarak sarak', // Indian — no matching keyword pattern
  'soda pop',   // K-pop — artist now in KPOP_ARTISTS, kept as fallback
]);

function isPoolEligible(track) {
  const titleLower  = track.title.toLowerCase().trim();
  const artistLower = track.artist.toLowerCase().trim();
  const combined    = `${track.title} ${track.artist}`;

  if (NON_LATIN_RE.test(combined))               return false; // non-Latin script
  if (FILM_SONG_RE.test(track.title))            return false; // Indian film tag
  if (BAD_VERSION_RE.test(track.title))          return false; // karaoke / instrumental / cover
  if (ARABIC_TITLE_RE.test(track.title))         return false; // Arabic title words
  if (SOUTH_ASIAN_TITLE_RE.test(track.title))    return false; // South Asian title words
  if (KPOP_ARTISTS.has(artistLower))             return false; // K-pop/East Asian artist
  if (BLOCKED_TITLES.has(titleLower))            return false; // manual title blocklist
  // Split collab artist fields (handles "Artist A x Artist B", "feat.", "&", etc.)
  const artistTokens = artistLower.split(/\s*[x&,\/]\s*|\s+feat\.?\s+/i).map(t => t.trim()).filter(Boolean);
  if (artistTokens.some(t => KPOP_ARTISTS.has(t) || BLOCKED_ARTISTS.has(t))) return false;
  return true;
}

// Official YouTube Music chart/curated playlists — searched by name so we get the
// real curated playlist, not songs whose title contains these words.
// These resolve to the actual official YouTube Music / Spotify-mirror curated playlists.
// Kept tight intentionally — fewer, higher-quality playlists beats a broad dump.
const CHART_PLAYLIST_QUERIES = [
  'Hot Hits USA',
  'Today\'s Hits',
];

async function buildCacheFromCharts() {
  if (!ytmusicReady) return;
  try {
    console.log('📊 Fetching chart playlists from YouTube Music...');
    const collected = [];
    const seenTracks = new Set();

    for (const q of CHART_PLAYLIST_QUERIES) {
      try {
        const { data: playlists } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/playlists`, { params: { q }, timeout: 15000 });
        if (!playlists.length) { console.warn(`  No playlist found for "${q}"`); continue; }
        const playlist = playlists[0]; // first result is the official playlist
        console.log(`  "${q}" → "${playlist.name}" (${playlist.playlistId})`);
        const { data: videos } = await axios.get(`${YTMUSIC_SERVICE_URL}/playlist/tracks`, { params: { id: playlist.playlistId, limit: 100 }, timeout: 20000 });
        let added = 0;
        for (const video of videos) {
          if (!video.videoId || !video.duration) continue;
          if (seenTracks.has(video.videoId)) continue;
          seenTracks.add(video.videoId);
          const track = mapYtmSongToTrack(video);
          if (!isValidSongDuration(track.duration)) continue;
          if (!isPoolEligible(track)) continue;
          collected.push(track);
          added++;
        }
        console.log(`  ✓ ${added}/${videos.length} songs added`);
      } catch (err) {
        console.warn(`  Chart playlist "${q}" failed:`, err.message);
      }
    }

    if (collected.length > 0) {
      poolSources.charts = collected;
      console.log(`✓ Charts pool: ${collected.length} unique songs from ${CHART_PLAYLIST_QUERIES.length} playlists`);
      mergePool();
    } else {
      console.warn('⚠ Charts: no songs found');
    }
  } catch (err) {
    console.warn('Charts build failed:', err.message);
  }
}

async function buildCacheFromMoods() {
  if (!ytmusicReady || activeMoodIds.size === 0) { poolSources.moods = []; return; }
  console.log(`🎭 Building moods pool (${activeMoodIds.size} active)...`);
  const collected = [];
  const seenTracks = new Set();

  for (const mood of AVAILABLE_MOODS.filter(m => activeMoodIds.has(m.id))) {
    try {
      const { data: playlists } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/playlists`, { params: { q: mood.query }, timeout: 15000 });
      if (!playlists.length) { console.warn(`  No playlist for mood "${mood.name}"`); continue; }
      const playlist = playlists[0];
      const { data: videos } = await axios.get(`${YTMUSIC_SERVICE_URL}/playlist/tracks`, { params: { id: playlist.playlistId, limit: 100 }, timeout: 20000 });
      let added = 0;
      for (const video of videos) {
        if (!video.videoId || !video.duration) continue;
        if (seenTracks.has(video.videoId)) continue;
        seenTracks.add(video.videoId);
        const track = mapYtmSongToTrack(video);
        if (!isValidSongDuration(track.duration)) continue;
        if (!isPoolEligible(track)) continue;
        collected.push(track);
        added++;
      }
      console.log(`  ✓ ${mood.emoji} ${mood.name} → "${playlist.name}": ${added} songs`);
    } catch (err) {
      console.warn(`  Mood "${mood.name}" failed:`, err.message);
    }
  }

  const seen = new Set();
  poolSources.moods = collected.filter(t => seen.has(t.trackId) ? false : seen.add(t.trackId));
  console.log(`✓ Moods pool: ${poolSources.moods.length} unique songs`);
}

async function buildCacheFromArtists() {
  if (artistSeeds.length === 0) { poolSources.artist = []; return; }
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const collected = [];
  for (const seed of artistSeeds) {
    try {
      if (ytmusicReady) {
        const songLimit = seed.limit || 20;
        const { data: songs } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/songs`, {
          params: { q: seed.artistName, limit: Math.min(songLimit * 3, 50) },
          timeout: 15000,
        });
        let added = 0;
        for (const song of songs) {
          if (added >= songLimit) break;
          if (!song.videoId || !song.duration) continue;
          // Keep only songs where the artist name matches (handles "feat." variants + accented names)
          const songArtistNorm = norm(song.artist || '');
          const seedArtistNorm = norm(seed.artistName);
          if (!songArtistNorm.includes(seedArtistNorm) && !seedArtistNorm.includes(songArtistNorm)) continue;
          const track = mapYtmSongToTrack(song);
          if (!isValidSongDuration(track.duration)) continue;
          if (!isPoolEligible(track)) continue;
          collected.push({ ...track, seedArtistId: seed.channelId });
          added++;
        }
        console.log(`✓ YTMusic artist "${seed.artistName}": ${added}/${songLimit} songs added`);
      } else if (YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE') {
        const items = await ytSearch(`${seed.artistName} official audio`, 10);
        const videoIds = items.map(i => i.id?.videoId).filter(Boolean);
        if (!videoIds.length) continue;
        const details = await ytVideoDetails(videoIds);
        details.sort((a, b) => scoreYtItem(b) - scoreYtItem(a));
        for (const item of details) {
          if (!item.id) continue;
          const track = mapVideoItemToTrack(item);
          if (!isValidSongDuration(track.duration)) continue;
          collected.push({ ...track, seedArtistId: seed.channelId });
        }
        console.log(`✓ Fallback artist "${seed.artistName}": fetched`);
      }
    } catch (err) {
      console.warn(`Failed to fetch tracks for ${seed.artistName}:`, err.message);
    }
  }
  const seen = new Set();
  poolSources.artist = collected.filter(t => seen.has(t.trackId) ? false : seen.add(t.trackId));
}

async function ensureCacheBuilt() {
  if (playlistCache.bar.length === 0) {
    await buildCacheFromCharts();
    await buildCacheFromMoods();
    if (artistSeeds.length > 0) await buildCacheFromArtists();
    mergePool();
    enrichPoolWithViewCounts().catch(() => {});
    enrichPoolWithLastFm().catch(() => {});
  }
}

async function rebuildPool() {
  await buildCacheFromCharts();
  await buildCacheFromMoods();
  if (artistSeeds.length > 0) await buildCacheFromArtists();
  mergePool();
  enrichPoolWithViewCounts().catch(() => {});
  enrichPoolWithLastFm().catch(() => {});
}

// Fetch YouTube view counts for pool tracks and store on the track objects.
// Uses a persistent cache so counts survive pool rebuilds without re-fetching.
// Runs async after pool build — recommendations fall back to unscored until done.
async function enrichPoolWithViewCounts() {
  if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') return;

  // Apply already-cached values immediately
  for (const t of playlistCache.bar) {
    if (viewCountCache.has(t.trackId)) t.viewCount = viewCountCache.get(t.trackId);
  }

  const uncached = playlistCache.bar.filter(t => !viewCountCache.has(t.trackId));
  if (!uncached.length) return;

  console.log(`📊 Fetching view counts for ${uncached.length} new tracks...`);
  const ids = uncached.map(t => t.trackId);

  for (let i = 0; i < ids.length; i += 50) {
    try {
      const { data } = await axios.get(`${YT_API}/videos`, {
        params: { part: 'statistics', id: ids.slice(i, i + 50).join(','), key: YOUTUBE_API_KEY },
      });
      for (const item of data.items || []) {
        const count = parseInt(item.statistics?.viewCount || '0', 10);
        viewCountCache.set(item.id, count);
        // Apply to pool track in-place
        const t = playlistCache.bar.find(t => t.trackId === item.id);
        if (t) t.viewCount = count;
      }
    } catch (err) {
      console.warn(`View count batch ${Math.floor(i / 50) + 1} failed:`, err.message);
    }
  }
  console.log(`✓ View count cache: ${viewCountCache.size} tracks`);
}

// ─── Last.fm Tag Enrichment ───────────────────────────────────────────────────
// Maps Last.fm user tags → energy and danceability scores (0–1).
// Tags with higher counts carry more weight in the final score.
const LFM_ENERGY_TAGS = {
  // Very high
  'high energy': 1.0, 'energetic': 1.0, 'pump up': 1.0, 'banger': 1.0,
  'workout': 0.95, 'hype': 0.95, 'intense': 0.9, 'hard rock': 0.9,
  'upbeat': 0.85, 'party anthem': 0.9, 'driving': 0.85,
  // High
  'party': 0.8, 'dance': 0.75, 'club': 0.8, 'fast': 0.8,
  'electronic': 0.7, 'hip hop': 0.65, 'rock': 0.65, 'punk': 0.8,
  // Medium
  'pop': 0.55, 'indie': 0.5, 'funk': 0.6, 'rnb': 0.55, 'r&b': 0.55,
  'soul': 0.5, 'reggae': 0.5,
  // Low
  'chill': 0.2, 'chillout': 0.15, 'mellow': 0.2, 'laid back': 0.2,
  'acoustic': 0.3, 'singer-songwriter': 0.3, 'slow': 0.15,
  // Very low
  'ambient': 0.1, 'sleep': 0.05, 'relaxing': 0.1, 'sad': 0.2,
  'melancholic': 0.2, 'ballad': 0.2, 'classical': 0.15, 'jazz': 0.35,
};

const LFM_DANCE_TAGS = {
  // Very high
  'dance': 1.0, 'danceable': 1.0, 'club': 0.95, 'disco': 0.95,
  'house': 0.95, 'techno': 0.9, 'edm': 0.9, 'trance': 0.85,
  'electronic dance': 1.0, 'groove': 0.85, 'funky': 0.85,
  // High
  'funk': 0.8, 'latin': 0.8, 'reggaeton': 0.85, 'hip hop': 0.75,
  'rnb': 0.75, 'r&b': 0.75, 'pop': 0.65, 'party': 0.8,
  // Medium
  'rock': 0.45, 'indie': 0.4, 'soul': 0.55,
  // Low
  'acoustic': 0.2, 'ballad': 0.15, 'ambient': 0.1,
  'classical': 0.1, 'sad': 0.15, 'slow': 0.1,
};

function scoreLastFmTags(tags, tagMap) {
  if (!tags?.length) return null;
  let weightedSum = 0, totalWeight = 0;
  for (const tag of tags.slice(0, 12)) {
    const name = tag.name.toLowerCase().trim();
    if (name in tagMap) {
      weightedSum += tagMap[name] * tag.count;
      totalWeight += tag.count;
    }
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

async function enrichPoolWithLastFm() {
  if (!LASTFM_API_KEY) return;

  // Apply cached values immediately so recommendations benefit without waiting
  for (const t of playlistCache.bar) {
    if (lastFmCache.has(t.trackId)) {
      Object.assign(t, lastFmCache.get(t.trackId));
    }
  }

  const uncached = playlistCache.bar.filter(t => !lastFmCache.has(t.trackId));
  if (!uncached.length) return;

  console.log(`🎵 Fetching Last.fm tags for ${uncached.length} tracks...`);
  let fetched = 0, failed = 0;

  for (const track of uncached) {
    try {
      const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
        params: {
          method:  'track.getTopTags',
          artist:  track.artist,
          track:   cleanTitle(track.title), // strip "(Official Video)" etc.
          api_key: LASTFM_API_KEY,
          format:  'json',
          autocorrect: 1,
        },
        timeout: 6000,
      });

      const tags = data?.toptags?.tag || [];
      const energy      = scoreLastFmTags(tags, LFM_ENERGY_TAGS);
      const danceability = scoreLastFmTags(tags, LFM_DANCE_TAGS);
      const result = { lfmEnergy: energy, lfmDance: danceability };

      lastFmCache.set(track.trackId, result);
      Object.assign(track, result);
      fetched++;
    } catch {
      failed++;
      lastFmCache.set(track.trackId, { lfmEnergy: null, lfmDance: null }); // cache miss so we don't retry
    }

    // 200ms between requests → stays well under Last.fm's 5 req/sec limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`✓ Last.fm enrichment: ${fetched} tagged, ${failed} missed`);
}

// ─── Queue Helpers ────────────────────────────────────────────────────────────
const sortQueue = () => queue.sort((a, b) => b.votes - a.votes || a.addedAt - b.addedAt);

function queueState() {
  return {
    queue: queue.map(item => ({ ...item, voters: Array.from(item.voters) })),
    currentTrack: currentTrack ? { ...currentTrack, voters: Array.from(currentTrack.voters) } : null,
    targetTrack:  targetTrack  ? { ...targetTrack,  voters: Array.from(targetTrack.voters)  } : null,
  };
}

function broadcast() {
  io.emit('queueUpdate', queueState());
}

function sanitizeTrack(track) {
  if (!track) return null;
  return { ...track, voters: Array.from(track.voters) };
}

// Resolve a single track to its pure-audio version using ytmusicapi videoType.
// Searches for the song by title+artist and picks the first result with
// videoType === 'MUSIC_VIDEO_TYPE_ATV' (Audio Track Version — what YouTube Music
// uses natively; never a music video).
async function resolveTrackAudio(item) {
  if (!item || item._audioResolved) return;
  item._audioResolved = true;
  if (!ytmusicReady) return;
  try {
    const { data: songs } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/songs`, {
      params: { q: `${item.title} ${item.artist}`, limit: 10 },
      timeout: 8000,
    });
    const audioTrack = songs.find(s => s.videoType === 'MUSIC_VIDEO_TYPE_ATV' && s.videoId);
    if (!audioTrack) {
      console.log(`🎵 No ATV found for "${item.title}" — keeping ${item.trackId}`);
      return;
    }
    if (audioTrack.videoId !== item.trackId) {
      console.log(`🎵 Audio resolved: "${item.title}" ${item.trackId} → ${audioTrack.videoId}`);
      item.trackId    = audioTrack.videoId;
      item.isTopicAudio = true;
    } else {
      console.log(`🎵 Already ATV: "${item.title}" (${item.trackId})`);
    }
  } catch (err) {
    console.warn(`resolveTrackAudio failed for "${item.title}":`, err.message);
  }
}

// Pre-warm: resolve the top N queue items in the background while the current song plays.
// Broadcasts after resolving so the host immediately gets the corrected videoIds
// and doesn't pre-load the original music-video version.
async function resolveQueueAudio(limit = 2) {
  const toResolve = queue.filter(item => !item._audioResolved).slice(0, limit);
  if (!toResolve.length) return;
  const before = toResolve.map(i => i.trackId);
  for (const item of toResolve) await resolveTrackAudio(item);
  const changed = toResolve.some((item, idx) => item.trackId !== before[idx]);
  if (changed) broadcast(); // push corrected videoIds to host before it pre-loads anything
}

async function ensureQueueHasUpcomingTrack() {
  if (queue.length > 0) return false;
  try {
    const tracks = await fetchRecommendations(1);
    if (tracks?.length) {
      const t = tracks[0];
      queue.push({
        id: 'fallback_' + uuidv4(),
        trackId:  t.trackId,
        title:    t.title,
        artist:   t.artist,
        album:    t.album,
        albumArt: t.albumArt,
        explicit: t.explicit,
        votes:    0,
        voters:   new Set(),
        addedAt:  Date.now(),
        isFallback: true,
      });
      resolveQueueAudio(1).catch(() => {}); // resolve immediately while previous song still plays
      return true;
    }
  } catch (err) {
    console.error('Failed to fetch recommendation for autoplay:', err.message);
  }
  return false;
}

function markTrackAsPlayed(trackOrId) {
  const trackId = typeof trackOrId === 'string' ? trackOrId : trackOrId?.trackId;
  if (!trackId) return;
  recentlyPlayed.set(trackId, Date.now());
  // Track recent artists for spread enforcement in fetchRecommendations
  const artist = (typeof trackOrId === 'object' ? trackOrId?.artist : null)
    || playlistCache.bar.find(t => t.trackId === trackId)?.artist;
  if (artist) {
    const norm = artist.toLowerCase().trim();
    recentArtists = [norm, ...recentArtists.filter(a => a !== norm)].slice(0, 3);
  }
}

let advanceInProgress = false;

async function advanceToNextTrack() {
  if (advanceInProgress) return sanitizeTrack(currentTrack);
  const now = Date.now();
  if (now - lastTrackChange < 3000) return sanitizeTrack(currentTrack);
  advanceInProgress = true;
  try {
    await ensureQueueHasUpcomingTrack();
    const next = queue.shift();
    if (next?.isFallback) console.log('🎵 Queue empty - playing fallback:', next.title, '-', next.artist);
    await resolveTrackAudio(next); // await BEFORE broadcasting — host gets the resolved ID
    targetTrack = next;
    if (next?.trackId) markTrackAsPlayed(next);
    lastTrackChange = now;
    await ensureQueueHasUpcomingTrack();
    broadcast();
    return sanitizeTrack(next);
  } finally {
    advanceInProgress = false;
  }
}

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
    if (ytmusicReady) {
      // Python ytmusicapi — returns only songs from the music catalog, never videos/junk
      const { data: songs } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/songs`, {
        params: { q: q.trim(), limit: 20 },
        timeout: 10000,
      });
      return res.json(songs.filter(s => s.videoId && s.duration).map(mapYtmSongToTrack));
    }
    // Fallback: YouTube Data API with Topic-channel preference
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') {
      return res.status(500).json({ error: 'No search backend available' });
    }
    const items = await ytSearch(q.trim(), 15);
    const videoIds = items.map(i => i.id?.videoId).filter(Boolean);
    if (!videoIds.length) return res.json([]);
    const details = await ytVideoDetails(videoIds);
    details.sort((a, b) => scoreYtItem(b) - scoreYtItem(a));
    res.json(details.map(mapVideoItemToTrack));
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/suggestions', async (req, res) => {
  try {
    const excludeIds = new Set([...queue.map(t => t.trackId), currentTrack?.trackId].filter(Boolean));
    if (!playlistCache.bar || playlistCache.bar.length === 0) return res.json([]);
    const suggestions = [];
    let attempts = 0;
    const maxAttempts = playlistCache.bar.length * 2;
    while (suggestions.length < 9 && attempts < maxAttempts) {
      const track = playlistCache.bar[suggestionRotationIndex];
      suggestionRotationIndex = (suggestionRotationIndex + 1) % playlistCache.bar.length;
      attempts++;
      if (track && !excludeIds.has(track.trackId)) suggestions.push(track);
    }
    res.json(suggestions);
  } catch (err) {
    console.error('Suggestions error:', err.message);
    res.json([]);
  }
});

// ─── CSV Parser (videoId,title,artist,album,albumArt) ─────────────────────────
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseYouTubeCSV(csvText) {
  const lines = csvText.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const tracks = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 2) continue;
      const trackId = cols[0].trim();
      if (!trackId || trackId.length < 5) continue;
      tracks.push({
        trackId,
        title:    cols[1] || 'Unknown',
        artist:   cols[2] || 'Unknown',
        album:    cols[3] || '',
        albumArt: cols[4] || null,
        explicit: false,
        popularity: null,
      });
    } catch (_) { /* skip malformed line */ }
  }
  return tracks;
}

// ─── Pool Management ──────────────────────────────────────────────────────────
app.get('/api/pool', requireAdmin, (req, res) => {
  res.json({
    mode: poolMode,
    artistDiscoveryRatio,
    activeMoodIds: [...activeMoodIds],
    artistSeeds,
    csvPlaylists: csvPlaylists.map(p => ({ name: p.name, trackCount: p.tracks.length, addedAt: p.addedAt })),
    sources: {
      csv:    { total: poolSources.csv.length },
      charts: { total: poolSources.charts.length },
      moods:  { total: poolSources.moods.length },
      genre:  { total: poolSources.genre.length },
      artist: { total: poolSources.artist.length },
      pinned: { total: poolSources.pinned.length },
    },
    totalInPool: playlistCache.bar.length,
    tracks: playlistCache.bar.map(t => ({
      trackId:  t.trackId,
      title:    t.title,
      artist:   t.artist,
      albumArt: t.albumArt,
      source:   t.source || 'genre',
      explicit: t.explicit,
    })),
  });
});

app.put('/api/pool/mode', requireAdmin, (req, res) => {
  const { mode } = req.body;
  if (!['playlist', 'discovery', 'both'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be playlist, discovery, or both' });
  }
  poolMode = mode;
  mergePool();
  res.json({ success: true, mode, totalInPool: playlistCache.bar.length });
});

app.put('/api/pool/ratio', requireAdmin, (req, res) => {
  const ratio = parseInt(req.body.ratio);
  if (isNaN(ratio) || ratio < 0 || ratio > 100) {
    return res.status(400).json({ error: 'ratio must be 0–100' });
  }
  artistDiscoveryRatio = ratio;
  mergePool();
  res.json({ success: true, artistDiscoveryRatio, totalInPool: playlistCache.bar.length });
});

app.get('/api/pool/moods', requireAdmin, (req, res) => {
  res.json(AVAILABLE_MOODS.map(m => ({ ...m, active: activeMoodIds.has(m.id) })));
});

app.put('/api/pool/moods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const mood = AVAILABLE_MOODS.find(m => m.id === id);
  if (!mood) return res.status(404).json({ error: 'Unknown mood' });
  const { active } = req.body;
  if (active) activeMoodIds.add(id);
  else activeMoodIds.delete(id);
  await buildCacheFromMoods();
  mergePool();
  res.json({ success: true, moodId: id, active, totalInPool: playlistCache.bar.length });
});

app.post('/api/pool/csv', requireAdmin, (req, res) => {
  const { name, csv } = req.body;
  if (!name || !csv) return res.status(400).json({ error: 'name and csv required' });
  if (csvPlaylists.find(p => p.name === name)) {
    return res.status(409).json({ error: 'A playlist with that name already exists — remove it first' });
  }
  const tracks = parseYouTubeCSV(csv);
  if (tracks.length === 0) return res.status(400).json({ error: 'No valid tracks found in CSV' });
  csvPlaylists.push({ name, addedAt: Date.now(), tracks });
  rebuildCsvSource();
  mergePool();
  console.log(`✓ CSV playlist "${name}" loaded: ${tracks.length} tracks`);
  res.json({ success: true, name, trackCount: tracks.length, totalInPool: playlistCache.bar.length });
});

// Import a YouTube playlist by ID — server fetches track list via Data API
app.post('/api/pool/youtube-playlist/:playlistId', requireAdmin, async (req, res) => {
  const { playlistId } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') {
    return res.status(500).json({ error: 'YouTube API key not configured' });
  }
  if (csvPlaylists.find(p => p.name === name)) {
    return res.status(409).json({ error: 'A playlist with that name already exists — remove it first' });
  }
  try {
    const tracks = await fetchYouTubePlaylistTracks(playlistId);
    if (tracks.length === 0) return res.status(400).json({ error: 'No tracks found in playlist' });
    csvPlaylists.push({ name, addedAt: Date.now(), tracks });
    rebuildCsvSource();
    mergePool();
    console.log(`✓ YouTube playlist "${name}" imported: ${tracks.length} tracks`);
    res.json({ success: true, name, trackCount: tracks.length, totalInPool: playlistCache.bar.length });
  } catch (err) {
    console.error('YouTube playlist import error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to import playlist' });
  }
});

async function fetchYouTubePlaylistTracks(playlistId) {
  const tracks = [];
  let pageToken = undefined;
  do {
    const params = { part: 'snippet', playlistId, maxResults: 50, key: YOUTUBE_API_KEY };
    if (pageToken) params.pageToken = pageToken;
    const { data } = await axios.get(`${YT_API}/playlistItems`, { params });
    const videoIds = (data.items || [])
      .map(i => i.snippet?.resourceId?.videoId)
      .filter(Boolean);
    if (videoIds.length) {
      const details = await ytVideoDetails(videoIds);
      for (const item of details) {
        if (!item.id) continue;
        const track = mapVideoItemToTrack(item);
        if (!isValidSongDuration(track.duration)) continue;
        tracks.push(track);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return tracks;
}

app.delete('/api/pool/csv/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const before = csvPlaylists.length;
  csvPlaylists = csvPlaylists.filter(p => p.name !== name);
  if (csvPlaylists.length === before) return res.status(404).json({ error: 'Playlist not found' });
  rebuildCsvSource();
  mergePool();
  res.json({ success: true, totalInPool: playlistCache.bar.length });
});


app.post('/api/pool/rebuild', requireAdmin, async (req, res) => {
  try {
    await buildCacheFromCharts();
    await buildCacheFromMoods();
    await buildCacheFromArtists();
    mergePool();
    res.json({ success: true, totalInPool: playlistCache.bar.length });
  } catch (err) {
    console.error('Pool rebuild error:', err.message);
    res.status(500).json({ error: 'Rebuild failed' });
  }
});

// Search YouTube Music for artists by name — returns top 5 with thumbnail for the admin picker
app.get('/api/search-artist', requireAdmin, async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query required' });
  if (!ytmusicReady) return res.status(503).json({ error: 'YouTube Music not ready' });
  try {
    const { data: artists } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/artists`, {
      params: { q: q.trim() },
      timeout: 10000,
    });
    res.json(artists.slice(0, 5));
  } catch (err) {
    console.error('Artist search error:', err.message);
    res.status(500).json({ error: 'Artist search failed' });
  }
});

app.post('/api/pool/artists', requireAdmin, async (req, res) => {
  const { artistId, artistName, thumbnail, limit } = req.body;
  if (!artistId || !artistName) return res.status(400).json({ error: 'artistId and artistName required' });
  if (artistSeeds.find(s => s.channelId === artistId)) {
    return res.status(409).json({ error: 'Artist already added' });
  }
  try {
    const songLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));
    artistSeeds.push({ channelId: artistId, artistName, thumbnail: thumbnail || null, limit: songLimit });
    await buildCacheFromArtists();
    mergePool();
    res.json({ success: true, artistId, artistName, totalInPool: playlistCache.bar.length });
  } catch (err) {
    console.error('Add artist seed error:', err.message);
    res.status(500).json({ error: 'Failed to add artist' });
  }
});

app.delete('/api/pool/artists/:artistId', requireAdmin, async (req, res) => {
  const { artistId } = req.params;
  const before = artistSeeds.length;
  artistSeeds = artistSeeds.filter(s => s.channelId !== artistId && s.artistName !== decodeURIComponent(artistId));
  if (artistSeeds.length === before) return res.status(404).json({ error: 'Artist seed not found' });
  await buildCacheFromArtists();
  mergePool();
  res.json({ success: true, totalInPool: playlistCache.bar.length });
});

app.post('/api/pool/tracks', requireAdmin, async (req, res) => {
  const { trackIds } = req.body;
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    return res.status(400).json({ error: 'trackIds (YouTube videoIds) array required' });
  }
  // Accept full YouTube URLs or raw 11-char video IDs
  const ids = trackIds.map(id => {
    if (typeof id !== 'string') return null;
    const urlMatch = id.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (urlMatch) return urlMatch[1];
    return id.trim().length >= 11 ? id.trim() : null;
  }).filter(Boolean);

  if (ids.length === 0) return res.status(400).json({ error: 'No valid YouTube video IDs provided' });
  if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') {
    return res.status(500).json({ error: 'YouTube API key not configured' });
  }
  try {
    const fetched = [];
    for (let i = 0; i < ids.length; i += 50) {
      const details = await ytVideoDetails(ids.slice(i, i + 50));
      fetched.push(...details.map(mapVideoItemToTrack));
    }
    let added = 0;
    for (const track of fetched) {
      if (!poolSources.pinned.find(t => t.trackId === track.trackId)) {
        poolSources.pinned.push(track);
        added++;
      }
    }
    mergePool();
    res.json({ success: true, added, totalInPool: playlistCache.bar.length });
  } catch (err) {
    console.error('Add pinned tracks error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch tracks from YouTube' });
  }
});

app.delete('/api/pool/tracks/:trackId', requireAdmin, (req, res) => {
  const { trackId } = req.params;
  const before = poolSources.pinned.length;
  poolSources.pinned = poolSources.pinned.filter(t => t.trackId !== trackId);
  if (poolSources.pinned.length === before) return res.status(404).json({ error: 'Pinned track not found' });
  mergePool();
  res.json({ success: true, totalInPool: playlistCache.bar.length });
});

app.delete('/api/pool/cache/:trackId', requireAdmin, (req, res) => {
  const { trackId } = req.params;
  const before = playlistCache.bar.length;
  playlistCache.bar     = playlistCache.bar.filter(t => t.trackId !== trackId);
  poolSources.genre     = poolSources.genre.filter(t => t.trackId !== trackId);
  poolSources.charts    = poolSources.charts.filter(t => t.trackId !== trackId);
  poolSources.moods     = poolSources.moods.filter(t => t.trackId !== trackId);
  poolSources.artist    = poolSources.artist.filter(t => t.trackId !== trackId);
  poolSources.pinned    = poolSources.pinned.filter(t => t.trackId !== trackId);
  if (playlistCache.bar.length === before) return res.status(404).json({ error: 'Track not in pool' });
  res.json({ success: true, totalInPool: playlistCache.bar.length });
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
  if (currentTrack?.trackId === trackId) return res.status(409).json({ error: 'Song is currently playing' });

  const item = {
    id: uuidv4(), trackId, title, artist, album, albumArt, explicit,
    votes: 1,
    voters: new Set([req.body.voterId || 'anon']),
    addedAt: Date.now(),
  };
  queue.push(item);
  sortQueue();
  resolveQueueAudio(2).catch(() => {}); // resolve top 2 while current song plays
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
app.post('/api/skip', requireAdmin, async (req, res) => {
  try {
    lastTrackChange = 0;
    const track = await advanceToNextTrack();
    res.json({ success: true, track });
  } catch (err) {
    console.error('Skip error:', err.message);
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

// ─── Host: Register ───────────────────────────────────────────────────────────
app.post('/api/device', (req, res) => {
  const { hostId } = req.body;
  if (!hostId) return res.status(400).json({ error: 'hostId required' });
  if (activeHost.hostId && activeHost.hostId !== hostId) {
    return res.status(409).json({ error: 'Another host session is active' });
  }
  activeHost.hostId = hostId;
  console.log('Host registered:', hostId);
  res.json({ success: true });
});

app.post('/api/host/ack', async (req, res) => {
  const { trackId, adoptTarget = false, naturalAdvance = false } = req.body || {};
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  if (naturalAdvance) {
    const queuedTrack = queue.find(item => item.trackId === trackId);
    if (queuedTrack) {
      currentTrack = queuedTrack;
      targetTrack  = queuedTrack;
      queue = queue.filter(item => item.trackId !== trackId);
      markTrackAsPlayed(trackId);
      await ensureQueueHasUpcomingTrack();
      resolveQueueAudio(2).catch(() => {}); // pre-warm next tracks while this one plays
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
        title:    req.body.title    || 'Unknown track',
        artist:   req.body.artist   || '',
        album:    req.body.album    || '',
        albumArt: req.body.albumArt || null,
        explicit: false,
        votes:    0,
        voters:   new Set(),
        addedAt:  Date.now(),
        isFallback: false,
      };
    }
    if (adoptTarget || !targetTrack) targetTrack = currentTrack;
  }

  broadcast();
  res.json({ success: true });
});

// ─── Host: Request Next Track ─────────────────────────────────────────────────
app.post('/api/next', async (req, res) => {
  try {
    const track = await advanceToNextTrack();
    res.json({ track });
  } catch (err) {
    console.error('Next error:', err.message);
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
    const sameHost     = activeHost.hostId   === hostId;
    const sameSocket   = activeHost.socketId === socket.id;
    if (noActiveHost || sameHost || sameSocket) {
      activeHost = { socketId: socket.id, hostId };
      socket.emit('hostAccepted', { hostId });
      return;
    }
    socket.emit('hostRejected', { reason: 'Another host page is already active' });
  });

  socket.on('disconnect', () => {
    if (activeHost.socketId === socket.id) {
      activeHost  = { socketId: null, hostId: null };
      targetTrack = null;
      console.log('Host session released');
    }
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, async () => {
  console.log(`🎵 Jukebox server running → http://${HOST}:${PORT}`);
  await startYTMusicService();
  rebuildPool().catch(err => console.warn('Startup pool build failed:', err.message));
});

// Graceful shutdown — kill the Python child process so it doesn't linger
process.on('SIGINT',  () => { ytmusicProcess?.kill(); process.exit(0); });
process.on('SIGTERM', () => { ytmusicProcess?.kill(); process.exit(0); });
