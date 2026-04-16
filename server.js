require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ytScrape = require('youtube-search-api');

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
const playedSessionHistory = new Set(); // Set of 'Artist - Title' strings played this session
const viewCountCache = new Map(); // trackId -> YouTube view count, persists across rebuilds
const lastFmCache    = new Map(); // trackId -> { energy, danceability }, persists across rebuilds
const acousticBrainzCache = new Map(); // trackId -> { bpm, mood_party, danceability, key, scale, mbid }
const CACHE_FILE = path.join(__dirname, 'metadata_cache.json');
const MOOD_BLACKLIST_FILE = path.join(__dirname, 'mood_blacklist.json');

const moodBlacklist = new Map(); // moodId -> Set of blacklisted 'Artist - Title' strings
const refillingMoodIds = new Set(); // mood IDs currently being refilled to prevent concurrent duplicates
let vibeStrictness = 70; // 0-100, controlled by admin panel

// 🎤 AI DJ Settings
let aiDjEnabled = false;
let aiDjVoice = 'Zephyr';

function saveMoodBlacklist() {
  try {
    const data = {};
    for (const [moodId, set] of moodBlacklist.entries()) {
      data[moodId] = Array.from(set);
    }
    fs.writeFileSync(MOOD_BLACKLIST_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save mood blacklist:', err.message);
  }
}

function loadMoodBlacklist() {
  if (!fs.existsSync(MOOD_BLACKLIST_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(MOOD_BLACKLIST_FILE, 'utf8'));
    for (const [moodId, strings] of Object.entries(data)) {
      moodBlacklist.set(moodId, new Set(strings));
    }
    console.log(`✓ Mood blacklist loaded: ${moodBlacklist.size} moods protected`);
  } catch (err) {
    console.warn('Failed to load mood blacklist:', err.message);
  }
}

const GEMINI_FALLBACK_KEYS = (process.env.GEMINI_API_KEYS_FALLBACK || '').split(',').map(k => k.trim()).filter(Boolean);
const GEMINI_MODELS = [
  'gemini-2.5-flash-lite'
];

let geminiDisabledUntil = 0;

async function generateTracksWithGemini(prompt, moodId = null) {
  if (Date.now() < geminiDisabledUntil) {
    console.log('🕒 Gemini is "Cooling Down" due to previous rate limits. Using fallback discovery.');
    return [];
  }

  return _generateTracksWithGeminiSingle(prompt, moodId, 1, 0, 0, 0);
}

async function _generateTracksWithGeminiSingle(prompt, moodId = null, attempt = 1, modelIndex = 0, keyIndex = 0, maxModelIndex = 2) {
  const primaryKey = process.env.GEMINI_API_KEY;
  const allKeys = [primaryKey, ...GEMINI_FALLBACK_KEYS].filter(Boolean);
  
  if (allKeys.length === 0) return [];
  if (Date.now() < geminiDisabledUntil) {
    return [];
  }

  const currentKey = allKeys[keyIndex % allKeys.length];
  const currentModel = GEMINI_MODELS[modelIndex % GEMINI_MODELS.length];

  console.log(`🤖 Gemini [${currentModel}] (Key ${keyIndex + 1}/${allKeys.length}): Generating tracks (Attempt ${attempt})...`);

  // Include blacklist in prompt if moodId is provided
  let blacklistContext = '';
  if (moodId && moodBlacklist.has(moodId)) {
    const list = Array.from(moodBlacklist.get(moodId)).slice(0, 50); // don't overwhelm prompt
    if (list.length > 0) {
      blacklistContext = `\nCRITICAL: Do NOT suggest any of these tracks: ${list.join(', ')}.`;
    }
  }

  const fullPrompt = `${prompt}${blacklistContext}\nReturn ONLY a JSON array of objects. \nEach object MUST include: {"artist": "...", "title": "...", "bpm": 128, "energy": 0.8, "danceability": 0.7, "valence": 0.6, "musical_key": "C Major"}. \nCRITICAL: Ensure all strings are properly escaped. Do NOT include unescaped double quotes inside values. Keep it high-quality and fitting for a bar.`;

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${currentKey}`,
      {
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      },
      { timeout: 30000 }
    );

    let resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    
    // HEURISTIC SANITIZER: Catch unescaped quotes inside JSON strings
    // This looks for quotes that are NOT followed by , } or :
    resultText = resultText.replace(/:\s*"([^"]*)"/g, (match, content) => {
      const sanitized = content.replace(/"/g, "'");
      return `: "${sanitized}"`;
    });

    const suggestions = JSON.parse(resultText);

    if (Array.isArray(suggestions)) {
      console.log(`✨ Gemini [${currentModel}] suggested ${suggestions.length} tracks with full AI-metadata.`);
      return suggestions;
    }
    return [];
  } catch (err) {
    const status = err.response?.status;
    const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message.includes('timeout');
    
    // 429: Rate limit. Wait and retry with SAME key if possible, or rotate.
    if (status === 429) {
      if (attempt <= 2) {
        const waitTime = attempt * 15000;
        console.warn(`🕒 Gemini [${currentModel}] Rate Limited (429). Waiting ${waitTime/1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        return _generateTracksWithGeminiSingle(prompt, moodId, attempt + 1, modelIndex, keyIndex, maxModelIndex);
      } else if (keyIndex + 1 < allKeys.length) {
        console.warn(`🔄 Gemini [${currentModel}] Key ${keyIndex + 1} exhausted. Rotating to Key ${keyIndex + 2}...`);
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, modelIndex, keyIndex + 1, maxModelIndex);
      } else {
        console.error('❌ Gemini All Keys Quota Exhausted. Disabling AI Vetting for 10 minutes.');
        geminiDisabledUntil = Date.now() + (10 * 60 * 1000);
      }
    } 
    // 503 or Timeout: Upstream overload. Rotate key OR model.
    else if (status === 503 || isTimeout) {
      console.warn(`🕒 Gemini [${currentModel}] ${status || 'Timeout'} (Attempt ${attempt}).`);
      
      if (attempt === 1) {
        // Simple retry same config once
        console.log('  Retry 1: Same model/key...');
        return _generateTracksWithGeminiSingle(prompt, moodId, attempt + 1, modelIndex, keyIndex, maxModelIndex);
      } else if (keyIndex + 1 < allKeys.length) {
        // Rotate key
        console.log(`  Retry 2: Rotating to Key ${keyIndex + 2}...`);
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, modelIndex, keyIndex + 1, maxModelIndex);
      } else if (modelIndex < maxModelIndex) {
        // Rotate model
        console.log(`  Retry 3: Falling back to more stable model [${GEMINI_MODELS[modelIndex + 1]}]...`);
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, modelIndex + 1, 0, maxModelIndex); // restart keys for new model
      } else {
        console.error(`❌ Gemini all fallbacks failed for ${status || 'Timeout'}.`);
      }
    } 
    else {
      console.warn(`❌ Gemini Generation failed: ${err.message}`);
    }
    return [];
  }
}


function saveMetadataCache() {
  try {
    const data = {
      lastFm: Object.fromEntries(lastFmCache),
      acousticBrainz: Object.fromEntries(acousticBrainzCache),
      viewCounts: Object.fromEntries(viewCountCache),
      playedSessionHistory: Array.from(playedSessionHistory),
      moodPoolCache: Object.fromEntries(moodPoolCache),
      poolState: {
        poolMode,
        artistDiscoveryRatio,
        smartFillEnabled,
        rollingDiscoveryEnabled,
        artistSeeds,
        activeMoodIds: [...activeMoodIds]
      },
      queueState: {
        queue: queue.map(t => ({ ...t, voters: Array.from(t.voters) })),
        currentTrack: currentTrack ? { ...currentTrack, voters: Array.from(currentTrack.voters) } : null,
        targetTrack:  targetTrack  ? { ...targetTrack,  voters: Array.from(targetTrack.voters)  } : null,
      }
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save metadata cache:', err.message);
  }
}

function loadMetadataCache() {
  if (!fs.existsSync(CACHE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (data.lastFm) {
      for (const [id, val] of Object.entries(data.lastFm)) lastFmCache.set(id, val);
    }
    if (data.acousticBrainz) {
      for (const [id, val] of Object.entries(data.acousticBrainz)) acousticBrainzCache.set(id, val);
    }
    if (data.viewCounts) {
      for (const [id, val] of Object.entries(data.viewCounts)) viewCountCache.set(id, val);
    }

    if (Array.isArray(data.playedSessionHistory)) {
      for (const s of data.playedSessionHistory) playedSessionHistory.add(s);
      console.log(`✓ Played history restored: ${playedSessionHistory.size} tracks`);
    }

    if (data.moodPoolCache) {
      for (const [id, tracks] of Object.entries(data.moodPoolCache)) {
        moodPoolCache.set(id, tracks);
      }
      console.log(`✓ Mood pool cache restored: ${moodPoolCache.size} moods populated`);
    }

    if (data.poolState) {
      const ps = data.poolState;
      if (ps.poolMode) poolMode = ps.poolMode;
      if (typeof ps.artistDiscoveryRatio === 'number') artistDiscoveryRatio = ps.artistDiscoveryRatio;
      if (typeof ps.smartFillEnabled === 'boolean') smartFillEnabled = ps.smartFillEnabled;
      if (typeof ps.rollingDiscoveryEnabled === 'boolean') rollingDiscoveryEnabled = ps.rollingDiscoveryEnabled;
      if (Array.isArray(ps.artistSeeds)) artistSeeds = ps.artistSeeds;
      if (Array.isArray(ps.activeMoodIds)) activeMoodIds = new Set(ps.activeMoodIds);
      console.log('✓ Pool state restored from cache');
    }

    if (data.queueState) {
      const qs = data.queueState;
      if (Array.isArray(qs.queue)) {
        queue = qs.queue.map(t => ({ ...t, voters: new Set(t.voters || []) }));
      }
      if (qs.currentTrack) {
        currentTrack = { ...qs.currentTrack, voters: new Set(qs.currentTrack.voters || []) };
      }
      if (qs.targetTrack) {
        targetTrack = { ...qs.targetTrack, voters: new Set(qs.targetTrack.voters || []) };
      }
      console.log(`✓ Active queue restored: ${queue.length} tracks`);
    }

    console.log(`✓ Metadata cache loaded: ${lastFmCache.size} Last.fm, ${acousticBrainzCache.size} AcousticBrainz, ${viewCountCache.size} view counts`);
  } catch (err) {
    console.warn('Failed to load metadata cache:', err.message);
  }
}

// ─── Pool State ───────────────────────────────────────────────────────────────
let poolMode = 'both'; // 'playlist' | 'discovery' | 'both'
let artistDiscoveryRatio = 50; // 0 = all discovery (charts/genre), 100 = all artist seeds
let smartFillEnabled = true;
let rollingDiscoveryEnabled = true;
let artistSeeds = []; // [{ channelId, artistName }]
let csvPlaylists = []; // [{ name, addedAt, tracks: [...] }]
let activeMoodIds = new Set(); // mood IDs currently active
const moodPoolCache = new Map(); // moodId -> Array of verified tracks
let discoveryProgress = { active: false, current: 0, target: 0, moodName: '' };
let poolSources = {
  csv:    [],
  genre:  [],
  charts: [],
  moods:  [],
  artist: [],
  pinned: [],
  smart:  [],
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
  { id: 'croatianeurodance', name: 'Croatian Eurodance', emoji: '🕺', query: 'Hrvatska eurodance 90s', description: "Provide a mix of popular 90s and 2000s Croatian Eurodance and dance-pop hits. Focus on high-energy tracks suitable for a club or bar atmosphere. Include well-known artists from the era." },
  { id: 'croatiantrash', name: 'Croatian Treš', emoji: '🇭🇷', query: 'Hrvatska trash 90s dance', description: "Act as a Croatian music expert specializing in the 'Treš' (Trash) sub-culture of the late 1990s and early 2000s. Provide a list of high-energy Croatian dance-pop and bubblegum pop songs. Focus strictly on the 'Cro-Dance' era characterized by Eurodance beats, heavy synthesizers, and club-friendly tempos. Include artists like Ivana Brkić, Vesna Pisarović (dance era), Colonia, ET, Karma, and Minea. Specifically look for tracks with the vibe of 'Oči boje kestena.' Avoid slow ballads, rock, or traditional klapa." },
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

async function getLastFmMetadata(artist, track) {
  if (!LASTFM_API_KEY) return null;
  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'track.getInfo',
        api_key: LASTFM_API_KEY,
        artist,
        track,
        format: 'json',
        autocorrect: 1
      },
      timeout: 5000
    });
    const info = data?.track;
    if (!info) return null;
    return {
      artist: info.artist?.name,
      track: info.name,
      durationMs: parseInt(info.duration),
      tags: info.toptags?.tag?.map(t => t.name.toLowerCase()) || []
    };
  } catch (err) {
    return null;
  }
}

async function findBestYouTubeMatch(lfmMeta) {
  if (!ytmusicReady) return null;
  const trackName = lfmMeta.title || lfmMeta.track;
  const artistName = lfmMeta.artist;
  if (!trackName || !artistName) return null;

  const query = `"${artistName}" "${trackName}"`;

  try {
    const { data: songs } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/songs`, {
      params: { q: query, limit: 5 },
      timeout: 10000,
    });

    if (!songs || !songs.length) {
      console.log(`  ❌ [YouTube] No results for: ${query}`);
      return null;
    }

    // Trust Gemini's curation — take first non-ATV result (ATV = not embeddable in IFrame)
    const best = songs.find(s => s.videoId && s.videoType !== 'MUSIC_VIDEO_TYPE_ATV') || songs[0];
    if (!best?.videoId) return null;

    console.log(`  ✅ [YouTube] Found match: "${best.title}" by ${best.artist}`);

    return {
      id: best.videoId,
      snippet: {
        title: best.title,
        channelTitle: best.artist,
        thumbnails: { default: { url: best.albumArt } }
      },
      contentDetails: { duration: `PT${best.duration}S` }
    };
  } catch (err) {
    console.error(`findBestYouTubeMatch error for ${query}:`, err.message);
    return null;
  }
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

// VEVO channels are domain-restricted: YouTube API reports embeddable:true but they fail
// in IFrame on localhost and non-partner domains. Filter them by channel name.
function isVevoChannel(channelTitle) {
  return /vevo/i.test(channelTitle || '');
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
  // Filter out videos that can't be embedded — they'll always error 101/150 in IFrame player.
  // Also filter VEVO channels: embeddable:true in API but domain-restricted on localhost/non-partner.
  return (data.items || []).filter(item =>
    item.status?.embeddable !== false &&
    !isVevoChannel(item.snippet?.channelTitle)
  );
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

// Score a youtube-search-api result (has channelTitle + title directly, no snippet wrapper).
// Same priority: Topic channel > official audio/lyric > neutral > live/cover/VEVO music video
function scoreYtScrapeItem(item) {
  const title   = (item.title || '').toLowerCase();
  const channel = (item.channelTitle || '');
  if (channel.endsWith('- Topic'))                                          return 3;
  if (title.includes('official audio') || title.includes('(audio)') ||
      title.includes('lyric') || title.includes('lyrics'))                  return 2;
  if (title.includes('live') || item.isLive)                               return -2;
  if (title.includes('cover') || title.includes('karaoke'))                return -3;
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
    // Include ALL discovery tracks from active moods via the cache
    const discoveryTracks = [];
    for (const moodId of activeMoodIds) {
      const cached = moodPoolCache.get(moodId) || [];
      discoveryTracks.push(...cached.map(t => ({ ...t, source: 'moods' })));
    }

    // Fallback to charts only if no moods are active
    if (activeMoodIds.size === 0) {
      discoveryTracks.push(...poolSources.charts.map(t => ({ ...t, source: 'charts' })));
    }

    // Combined pool of all available discovery methods
    const autoPool = [
      ...poolSources.artist.map(t => ({ ...t, source: 'artist' })),
      ...poolSources.smart.map(t => ({ ...t, source: 'smart' })),
      ...discoveryTracks
    ];

    for (const track of autoPool) {
      // Reject ATV (YouTube Music audio-only) IDs — not embeddable in IFrame, always error 101/150
      if (track.videoType === 'MUSIC_VIDEO_TYPE_ATV') continue;
      if (!seen.has(track.trackId)) {
        seen.add(track.trackId);
        merged.push({ ...track });
      }
    }
  }

  playlistCache.bar = shuffleArray(merged);
  suggestionRotationIndex = 0;
  console.log(`✓ Pool merged: ${merged.length} tracks [mode: ${poolMode}] (csv: ${poolSources.csv.length}, charts: ${poolSources.charts.length}, moods: ${poolSources.moods.length}, smart: ${poolSources.smart.length}, artist: ${poolSources.artist.length}, pinned: ${poolSources.pinned.length})`);
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

    // Derive current state — prefer AcousticBrainz mood_party, then Last.fm score (0–1), fall back to source tier (0–1)
    const currentPoolTrack = currentTrack
      ? pool.find(t => t.trackId === currentTrack.trackId)
      : null;
    
    const currentEnergy = currentPoolTrack?.mood_party ?? currentPoolTrack?.lfmEnergy ?? (getEnergyTier(currentPoolTrack) / 3);
    const currentBpm    = currentPoolTrack?.bpm || null;

    // Score each candidate
    const scores = candidates.map(track => {
      let score = 1.0;

      // Popularity: log scale
      if (track.viewCount != null && track.viewCount > 0) {
        const pop = Math.min(1, Math.log10(track.viewCount + 1) / 8);
        score *= (0.4 + 0.6 * pop);
      }

      // Energy continuity: prefer AcousticBrainz, then Last.fm 0–1 score, else source tier
      const trackEnergy = track.mood_party ?? track.lfmEnergy ?? (getEnergyTier(track) / 3);
      const energyDiff  = Math.abs(trackEnergy - currentEnergy);
      if      (energyDiff > 0.5)  score *= 0.2;
      else if (energyDiff > 0.25) score *= 0.6;

      // BPM continuity: avoid jarring tempo changes
      if (currentBpm && track.bpm) {
        const bpmDiff = Math.abs(track.bpm - currentBpm);
        if (bpmDiff > 40) score *= 0.5;
      }

      // Danceability bonus: prefer AcousticBrainz, then Last.fm
      const dance = track.danceability ?? track.lfmDance;
      if (dance != null) {
        score *= (0.7 + 0.3 * dance);
      }

      // Artist spread: anti-repetition
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
    // Priority: use the specific Library path for Python 3.13 if on macOS
    const pythonCmd = process.platform === 'darwin' 
      ? '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3' 
      : (process.platform === 'win32' ? 'python' : 'python3');
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

async function fetchSmartDiscovery(seedOverride = null, attempt = 1, skipGemini = false) {
  if (!smartFillEnabled) return;
  if (!LASTFM_API_KEY || !YOUTUBE_API_KEY) return;
  
  let activeMoodId = null;
  let activeMoodName = 'General Vibe';
  
  if (activeMoodIds.size > 0) {
    activeMoodId = Array.from(activeMoodIds)[0];
    const mood = AVAILABLE_MOODS.find(m => m.id === activeMoodId);
    activeMoodName = mood ? mood.name : 'General Vibe';
  }

  if (skipGemini) {
    console.log(`🕒 Rolling Discovery: AI vetting skipped. Using fallback logic for replacement.`);
    // Fallback to random chart song if AI is disabled
    await fetchSafetyReplacement();
    return;
  }

  const seedTrack = seedOverride || currentTrack || playlistCache.bar[playlistCache.bar.length * Math.random() | 0];
  if (!seedTrack) return;

  console.log(`🤖 AI-DJ Rolling: Finding perfect transition for "${seedTrack.artist} - ${seedTrack.title}" in mood "${activeMoodName}"...`);

  try {
    const prompt = `I am a bar DJ. The last track played was "${seedTrack.artist} - ${seedTrack.title}". 
The current vibe is: "${activeMoodName}".
Give me 5 tracks that would flow perfectly right after this one. 
Keep the energy consistent and the vibe authentic to the mood.`;
    
    const suggestions = await generateTracksWithGemini(prompt, activeMoodId);
    
    if (!suggestions.length) {
      console.warn('⚠️ [AI-DJ] Gemini gave no rolling suggestions. Using safety fallback.');
      await fetchSafetyReplacement();
      return;
    }

    let foundMatch = false;
    for (const s of suggestions) {
      const winner = await findBestYouTubeMatch(s);
      if (winner) {
        const track = mapVideoItemToTrack(winner);
        if (isValidSongDuration(track.duration) && isPoolEligible(track)) {
          // Check for blacklist one last time
          const blacklist = activeMoodId ? moodBlacklist.get(activeMoodId) : null;
          const entry = `${track.artist} - ${track.title}`;
          if (blacklist && blacklist.has(entry)) continue;

          poolSources.smart.push({ ...track, source: 'smart' });
          if (poolSources.smart.length > 150) poolSources.smart.shift();
          
          console.log(`✨ AI-DJ Picked Transition: "${track.title}"`);
          foundMatch = true;
          mergePool();
          break;
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (!foundMatch) {
      console.warn('⚠️ [AI-DJ] Could not resolve any Gemini suggestions on YouTube. Using safety fallback.');
      await fetchSafetyReplacement();
    }
  } catch (err) {
    console.warn('AI-DJ Rolling Discovery failed:', err.message);
    await fetchSafetyReplacement();
  }
}

async function fetchSafetyReplacement() {
  // Try to pick a track from Charts pool that isn't already in the merged pool
  const chartTracks = poolSources.charts;
  if (chartTracks.length > 0) {
    const randomChart = chartTracks[chartTracks.length * Math.random() | 0];
    if (randomChart) {
       poolSources.smart.push({ ...randomChart, source: 'smart' });
       console.log(`✅ Safety Fallback: Added chart track "${randomChart.title}" to maintain pool size.`);
       mergePool();
       return;
    }
  }
  console.warn('❌ Safety Fallback failed: No chart tracks available.');
}

async function processDiscoveredTracks(tracks, maxToStore = null, moodName = 'General', moodId = null, skipGemini = false) {
  let addedCount = 0;
  const existingIds = new Set(playlistCache.bar.map(t => t.trackId));
  const blacklist = moodId ? moodBlacklist.get(moodId) : null;

  console.log(`🤖 Smart-Fill: Processing ${tracks.length} candidates...`);

  const discovered = [];
  for (const s of tracks) {
    if (maxToStore && addedCount >= maxToStore) break;
    if (s.match && parseFloat(s.match) < 0.6) continue;

    const meta = await getLastFmMetadata(s.artist?.name || s.artist, s.name);
    if (!meta) continue;

    const winner = await findBestYouTubeMatch(meta);
    if (winner) {
      if (existingIds.has(winner.id)) {
        console.log(`  ⏭️ [Smart-Fill] "${meta.track}" already in pool, skipping.`);
        continue;
      }
      
      if (blacklist && blacklist.has(winner.id)) {
        console.log(`  🚫 [Blacklist] "${meta.track}" is blacklisted for mood "${moodName}", skipping.`);
        continue;
      }

      const track = mapVideoItemToTrack(winner);
      if (isValidSongDuration(track.duration)) {
        discovered.push({ ...track, source: 'smart' });
        addedCount++;
      }
    }
    // Minimal throttle to respect APIs
    if (!maxToStore || addedCount < maxToStore) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // Phase 2: AI Vibe Check (Gemini)
  let vetted = discovered;
  if (discovered.length > 0 && moodId && !skipGemini) {
    vetted = await vetTracksWithGemini(discovered, moodName, moodId);
  }

  // Phase 3: Add vetted tracks to pool
  if (vetted.length > 0) {
    vetted.forEach(track => {
      poolSources.smart.push(track);
      if (poolSources.smart.length > 150) poolSources.smart.shift();
    });
    mergePool();
  } else if (discovered.length > 0) {
    console.log('🤖 Smart-Fill: All discovered tracks were rejected by Gemini (or skipped).');
  } else {
    console.log('🤖 Smart-Fill: No new high-confidence matches found.');
  }

  return vetted.length;
}

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
        const playlist = playlists[0];
        console.log(`  "${q}" → "${playlist.name}" (${playlist.playlistId})`);
        const { data: videos } = await axios.get(`${YTMUSIC_SERVICE_URL}/playlist/tracks`, { params: { id: playlist.playlistId, limit: 100 }, timeout: 20000 });
        let added = 0;
        for (const video of videos) {
          if (!video.videoId || !video.duration) continue;
          if (seenTracks.has(video.videoId)) continue;
          if (video.videoType === 'MUSIC_VIDEO_TYPE_ATV') continue; // ATV = not embeddable in IFrame
          seenTracks.add(video.videoId);
          const track = mapYtmSongToTrack(video);
          if (!isValidSongDuration(track.duration)) continue;
          if (!isPoolEligible(track)) continue;
          collected.push(track);
          added++;
        }
        console.log(`  ✓ ${added}/${videos.length} non-ATV songs collected`);
      } catch (err) {
        console.warn(`  Chart playlist "${q}" failed:`, err.message);
      }
    }

    if (collected.length > 0) {
      // Validate embeddability via YouTube Data API — filters out any remaining restricted videos
      // Embeddability check is mandatory — never add unvalidated tracks to the pool.
      // If no API key, log a warning and skip rather than letting non-embeddable tracks through.
      if (YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE') {
        console.log(`📋 Charts: validating ${collected.length} tracks for IFrame embeddability...`);
        const embeddableIds = new Set();
        const ids = collected.map(t => t.trackId);
        for (let i = 0; i < ids.length; i += 50) {
          try {
            const details = await ytVideoDetails(ids.slice(i, i + 50));
            details.forEach(d => embeddableIds.add(d.id));
          } catch (_) {}
        }
        poolSources.charts = collected.filter(t => embeddableIds.has(t.trackId));
      } else {
        console.warn('⚠ Charts: no YouTube API key — skipping pool build to avoid non-embeddable tracks entering pool');
        poolSources.charts = [];
      }
      console.log(`✓ Charts pool: ${poolSources.charts.length}/${collected.length} embeddable tracks`);
      mergePool();
    } else {
      console.warn('⚠ Charts: no songs found');
    }
  } catch (err) {
    console.warn('Charts build failed:', err.message);
  }
}

async function buildCacheFromMoods() {
  if (!LASTFM_API_KEY || !YOUTUBE_API_KEY || activeMoodIds.size === 0) { 
    poolSources.moods = []; 
    return; 
  }

  const selectedMoods = Array.from(activeMoodIds).map(id => AVAILABLE_MOODS.find(m => m.id === id)).filter(Boolean);
  
  // 1. Detect if we should do a BLENDED startup build
  if (selectedMoods.length > 1) {
    const needsBuilding = selectedMoods.some(m => !moodPoolCache.has(m.id) || moodPoolCache.get(m.id).length < 10);
    if (needsBuilding) {
      const moodNamesStr = selectedMoods.map(m => m.name).join(' + ');
      console.log(`🎭 AI-DJ Moods: Building BLENDED startup pool for: ${moodNamesStr}...`);
      
      // Concurrency Lock
      const idsToLock = selectedMoods.map(m => m.id);
      if (idsToLock.some(id => refillingMoodIds.has(id))) return;
      idsToLock.forEach(id => refillingMoodIds.add(id));

      try {
        const TARGET_COUNT = 25;
        discoveryProgress = { active: true, current: 0, target: TARGET_COUNT, moodName: `${moodNamesStr} (Blended)` };
        broadcast();

        const descriptions = selectedMoods.map(m => m.description).filter(Boolean).join('\n');
        let prompt = `You are a world-class DJ and curator for a trendy bar. \nI need a cohesive, blended set of tracks that perfectly combines these vibes: \n\n${moodNamesStr}`;
        if (descriptions) prompt += `\n\nSpecific vibe details:\n${descriptions}`;
        prompt += `\n\nGive me ${TARGET_COUNT + 5} high-quality, essential tracks that bridge these moods naturally. Ensure variety but keep the flow perfect for a bar.`;

        const suggestions = await generateTracksWithGemini(prompt, null);
        if (suggestions.length > 0) {
          const blendedTracks = [];
          const seenLocal = new Set();
          let moodAdded = 0;

          for (const s of suggestions) {
            if (moodAdded >= TARGET_COUNT) break;
            const winner = await findBestYouTubeMatch(s);
            if (winner && !seenLocal.has(winner.id)) {
              const track = mapVideoItemToTrack(winner);
              if (isValidSongDuration(track.duration) && isPoolEligible(track)) {
                seenLocal.add(track.trackId);
                const enrichedTrack = { 
                  ...track, 
                  source: 'moods',
                  bpm: s.bpm || null,
                  mood_party: s.energy || null,
                  danceability: s.danceability || null,
                  valence: s.valence || null,
                  key: s.musical_key || null,
                  aiGenerated: true
                };
                blendedTracks.push(enrichedTrack);
                moodAdded++;
                discoveryProgress.current = moodAdded;
                
                for (const m of selectedMoods) {
                  moodPoolCache.set(m.id, blendedTracks);
                }
                mergePool();
                broadcast();
              }
            }
            await new Promise(r => setTimeout(r, 200));
          }
        }
      } catch (err) {
        console.error('Blended startup build failed:', err.message);
      } finally {
        idsToLock.forEach(id => refillingMoodIds.delete(id));
        discoveryProgress = { active: false, current: 0, target: 0, moodName: '' };
        broadcast();
      }
      return; // Blended build complete
    }
  }

  // 2. Fallback: Individual builds (standard logic)
  console.log(`🎭 AI-DJ Moods: Checking individual pools for ${activeMoodIds.size} active moods...`);

  for (const moodId of activeMoodIds) {
    if (moodPoolCache.has(moodId) && moodPoolCache.get(moodId).length >= 10) {
      console.log(`✓ Using cached tracks for mood: "${moodId}"`);
      continue;
    }

    if (refillingMoodIds.has(moodId)) continue;
    refillingMoodIds.add(moodId);

    const mood = AVAILABLE_MOODS.find(m => m.id === moodId);
    if (!mood) { refillingMoodIds.delete(moodId); continue; }

    const TARGET_COUNT = 25;
    discoveryProgress = { active: true, current: 0, target: TARGET_COUNT, moodName: mood.name };
    broadcast();

    console.log(`🔍 [AI-DJ Discovery] Vibe: "${mood.name}"...`);
    const moodCollected = [];
    const seenLocal = new Set();

    try {
      const basePrompt = mood.description || `You are a bar DJ. The current mood is: "${mood.name}". Include a mix of well-known hits and perfect "deep cuts" for a bar atmosphere.`;
      const prompt = `${basePrompt}\nGive me ${TARGET_COUNT + 5} high-quality, essential tracks that perfectly fit this vibe.`;
      
      const suggestions = await generateTracksWithGemini(prompt, moodId);
      
      if (suggestions.length > 0) {
        let moodAdded = 0;
        for (const s of suggestions) {
          if (moodAdded >= TARGET_COUNT) break;
          const winner = await findBestYouTubeMatch(s);
          if (winner && !seenLocal.has(winner.id)) {
            const track = mapVideoItemToTrack(winner);
            if (isValidSongDuration(track.duration) && isPoolEligible(track)) {
              seenLocal.add(track.trackId);
              const enrichedTrack = { 
                ...track, 
                source: 'moods',
                bpm: s.bpm || null,
                mood_party: s.energy || null,
                danceability: s.danceability || null,
                valence: s.valence || null,
                key: s.musical_key || null,
                aiGenerated: true
              };
              moodCollected.push(enrichedTrack);
              moodAdded++;
              discoveryProgress.current = moodAdded;
              moodPoolCache.set(moodId, moodCollected);
              mergePool();
              broadcast();
            }
          }
          await new Promise(r => setTimeout(r, 200));
        }
        console.log(`  ✓ ${mood.emoji} ${mood.name}: Final total: ${moodAdded} tracks`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.warn(`  AI-DJ discovery for "${mood.name}" failed:`, err.message);
    } finally {
      refillingMoodIds.delete(moodId);
    }
  }

  discoveryProgress = { active: false, current: 0, target: 0, moodName: '' };
  mergePool();
  broadcast();
}

async function refillMoodPool(moodId) {
  const mood = AVAILABLE_MOODS.find(m => m.id === moodId);
  if (!mood) return;

  // 1. Determine target moods (blended or single)
  let targetMoods = [mood];
  let isBlended = false;
  if (activeMoodIds.size > 1 && activeMoodIds.has(moodId)) {
    targetMoods = Array.from(activeMoodIds).map(id => AVAILABLE_MOODS.find(m => m.id === id)).filter(Boolean);
    isBlended = true;
  }

  // 2. Concurrency Lock
  const idsToLock = targetMoods.map(m => m.id);
  if (idsToLock.some(id => refillingMoodIds.has(id))) {
    // A refill is already in progress for one of these moods
    return;
  }
  idsToLock.forEach(id => refillingMoodIds.add(id));

  const moodNamesStr = targetMoods.map(m => m.name).join(' + ');
  const refillDisplayName = isBlended ? `${moodNamesStr} (Blended Refill)` : `${mood.name} (Refill)`;

  try {
    const currentTracks = moodPoolCache.get(moodId) || [];
    const inPoolList = currentTracks.map(t => `${t.artist} - ${t.title}`).join(', ');
    const alreadyPlayedList = Array.from(playedSessionHistory).slice(-50).join(', ');

    // 3. Combined Blacklist for Blends
    let combinedBlacklist = new Set();
    for (const m of targetMoods) {
      if (moodBlacklist.has(m.id)) {
        moodBlacklist.get(m.id).forEach(t => combinedBlacklist.add(t));
      }
    }
    const blacklistArray = Array.from(combinedBlacklist).slice(0, 50);
    const blacklistContext = blacklistArray.length > 0 
      ? `\nCRITICAL: Do NOT suggest any of these tracks: ${blacklistArray.join(', ')}.` 
      : '';

    let basePrompt = '';
    if (isBlended) {
      const descriptions = targetMoods.map(m => m.description).filter(Boolean).join('\n');
      basePrompt = `You are a world-class DJ. I need to refill a BLENDED mood pool combining: ${moodNamesStr}.
Specific vibe details:
${descriptions}
Keep the vibe cohesive and transitional between these styles. High-energy for a bar.`;
    } else {
      basePrompt = mood.description || `I am a bar DJ. My current vibe is: "${mood.name}". Keep the vibe consistent, high-energy for a bar.`;
    }

    const prompt = `${basePrompt}${blacklistContext}
  
CRITICAL CONTEXT:
Currently in pool: ${inPoolList}.
Played this session: ${alreadyPlayedList}.

Give me 15 NEW, high-quality tracks that fit this vibe but are NOT in either list above.`;

    // 4. Fetch suggestions (pass null for moodId to avoid duplicate blacklist handling inside generateTracksWithGemini)
    const suggestions = await generateTracksWithGemini(prompt, null);
    if (!suggestions.length) return;

    console.log(`🔍 [Refill] Resolving ${suggestions.length} new tracks for ${refillDisplayName}...`);
    
    // Set discovery progress for UI feedback during refill
    discoveryProgress = { active: true, current: 0, target: suggestions.length, moodName: refillDisplayName };
    broadcast();

    const seenIds = new Set(currentTracks.map(t => t.trackId));
    let added = 0;

    for (const s of suggestions) {
      const winner = await findBestYouTubeMatch(s);
      if (winner && !seenIds.has(winner.id)) {
        const track = mapVideoItemToTrack(winner);
        if (isValidSongDuration(track.duration) && isPoolEligible(track)) {
          const enrichedTrack = { 
            ...track, 
            source: 'moods',
            bpm: s.bpm || null,
            mood_party: s.energy || null,
            danceability: s.danceability || null,
            valence: s.valence || null,
            key: s.musical_key || null,
            aiGenerated: true
          };
          
          // Add to ALL target moods
          for (const m of targetMoods) {
            const list = moodPoolCache.get(m.id) || [];
            // De-duplicate if somehow already there
            if (!list.find(t => t.trackId === track.trackId)) {
              list.push(enrichedTrack);
              moodPoolCache.set(m.id, list);
            }
          }

          seenIds.add(track.trackId);
          added++;
          discoveryProgress.current = added;
          mergePool();
          broadcast();
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`✅ [Refill] Added ${added} new tracks to ${refillDisplayName}.`);
    broadcast();
  } catch (err) {
    console.error(`Refill failed for ${refillDisplayName}:`, err.message);
  } finally {
    idsToLock.forEach(id => refillingMoodIds.delete(id));
    discoveryProgress = { active: false, current: 0, target: 0, moodName: '' };
    broadcast();
  }
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
          // Skip ATV (Audio Track Version) IDs — they require YouTube Music auth and get 101/150 in IFrame
          if (song.videoType === 'MUSIC_VIDEO_TYPE_ATV') continue;
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
      } else {
        // ytmusicapi service is down — skip this artist, do not fall back to ytSearch.
        // ytSearch costs 100 units per call; with many artist seeds this would exhaust the daily quota instantly.
        console.warn(`⚠ Skipping artist "${seed.artistName}" — ytmusicapi not available`);
      }
    } catch (err) {
      console.warn(`Failed to fetch tracks for ${seed.artistName}:`, err.message);
    }
  }

  // Deduplicate
  const seen = new Set();
  const deduped = collected.filter(t => seen.has(t.trackId) ? false : seen.add(t.trackId));

  // Validate embeddability for any tracks sourced from ytmusicapi
  // Embeddability check is mandatory — never add unvalidated tracks to the pool.
  // If no API key, log a warning and skip rather than letting non-embeddable tracks through.
  if (YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE' && deduped.length > 0) {
    console.log(`📋 Artists: validating ${deduped.length} tracks for IFrame embeddability...`);
    const embeddableIds = new Set();
    const ids = deduped.map(t => t.trackId);
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const details = await ytVideoDetails(ids.slice(i, i + 50));
        details.forEach(d => embeddableIds.add(d.id));
      } catch (_) {}
    }
    poolSources.artist = deduped.filter(t => embeddableIds.has(t.trackId));
    console.log(`✓ Artist pool: ${poolSources.artist.length}/${deduped.length} embeddable tracks`);
  } else if (deduped.length > 0) {
    console.warn('⚠ Artists: no YouTube API key — skipping pool build to avoid non-embeddable tracks entering pool');
    poolSources.artist = [];
  }

  mergePool();
}

async function ensureCacheBuilt() {
  if (playlistCache.bar.length === 0) {
    await buildCacheFromCharts();
    await buildCacheFromMoods();
    if (artistSeeds.length > 0) await buildCacheFromArtists();
    mergePool();
    enrichPoolWithViewCounts().catch(() => {});
    enrichPoolWithAcousticBrainz()
      .then(() => enrichPoolWithLastFm())
      .catch(() => enrichPoolWithLastFm());
  }
}

async function rebuildPool() {
  // Always rebuild the static charts pool on startup
  await buildCacheFromCharts();

  // On startup, we only use what was loaded from metadata_cache.json for moods.
  // If the cache was empty, moodPoolCache remains empty until user "Populates" it.
  if (moodPoolCache.size > 0) {
    console.log(`✓ Mood pool cache restored: ${moodPoolCache.size} moods active`);
  } else {
    console.log('🔄 Mood pool cache empty. Waiting for manual population.');
  }

  if (artistSeeds.length > 0) await buildCacheFromArtists();
  mergePool();
  enrichPoolWithViewCounts().catch(() => {});
  enrichPoolWithAcousticBrainz()
    .then(() => enrichPoolWithLastFm())
    .catch(() => enrichPoolWithLastFm());

  // Kick off autonomous discovery - SKIP GEMINI on startup
  fetchSmartDiscovery(null, 1, true).catch(() => {});
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
  saveMetadataCache();
  console.log(`✓ View count cache enriched: ${viewCountCache.size} tracks total`);
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

async function resolveMbid(artist, title) {
  try {
    const query = `artist:"${artist}" AND recording:"${cleanTitle(title)}"`;
    const { data } = await axios.get('https://musicbrainz.org/ws/2/recording/', {
      params: { query, fmt: 'json', limit: 1 },
      headers: { 'User-Agent': 'BarJukebox/1.0.0 ( m.lovrekovic@gmail.com )' }
    });
    return data?.recordings?.[0]?.id || null;
  } catch (err) {
    return null;
  }
}

async function fetchAcousticBrainzData(mbid) {
  try {
    const { data } = await axios.get(`https://acousticbrainz.org/api/v1/${mbid}/high-level`);
    const hl = data?.highlevel;
    if (!hl) return null;
    
    return {
      bpm:          hl.bpm?.all?.bpm,
      mood_party:   hl.mood_party?.all?.party,
      danceability: hl.danceability?.all?.danceable,
      key:          hl.tonal?.key_key,
      scale:         hl.tonal?.key_scale,
      mbid:         mbid
    };
  } catch (err) {
    return null;
  }
}

async function enrichPoolWithAcousticBrainz() {
  // Apply cached values immediately
  for (const t of playlistCache.bar) {
    if (acousticBrainzCache.has(t.trackId)) {
      Object.assign(t, acousticBrainzCache.get(t.trackId));
    }
  }

  const uncached = playlistCache.bar.filter(t => !acousticBrainzCache.has(t.trackId));
  if (!uncached.length) return;

  console.log(`🎵 Fetching AcousticBrainz features for ${uncached.length} tracks...`);
  let fetched = 0, failed = 0;

  for (const track of uncached) {
    const mbid = await resolveMbid(track.artist, track.title);
    if (mbid) {
      const data = await fetchAcousticBrainzData(mbid);
      if (data) {
        acousticBrainzCache.set(track.trackId, data);
        Object.assign(track, data);
        fetched++;
      } else {
        failed++;
        acousticBrainzCache.set(track.trackId, { mbid: mbid, bpm: null }); // mark as tried
      }
    } else {
      failed++;
      acousticBrainzCache.set(track.trackId, { mbid: null }); // mark as tried
    }
    // Respect MusicBrainz rate limit (1 req/sec)
    await new Promise(r => setTimeout(r, 1050));
  }
  saveMetadataCache();
  console.log(`✓ AcousticBrainz enrichment: ${fetched} analyzed, ${failed} missed`);
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
  saveMetadataCache();
  console.log(`✓ Last.fm enrichment: ${fetched} tagged, ${failed} missed`);
}

// ─── Queue Helpers ────────────────────────────────────────────────────────────
const sortQueue = () => queue.sort((a, b) => b.votes - a.votes || a.addedAt - b.addedAt);

function queueState() {
  return {
    queue: queue.map(item => ({ ...item, voters: Array.from(item.voters) })),
    currentTrack: currentTrack ? { ...currentTrack, voters: Array.from(currentTrack.voters) } : null,
    targetTrack:  targetTrack  ? { ...targetTrack,  voters: Array.from(targetTrack.voters)  } : null,
    aiDjEnabled,
    aiDjVoice,
    geminiApiKey: process.env.GEMINI_API_KEY,
  };
}

function broadcast() {
  io.emit('queueUpdate', queueState());
  io.emit('poolUpdate');
  saveMetadataCache();
}

function sanitizeTrack(track) {
  if (!track) return null;
  return { ...track, voters: Array.from(track.voters) };
}

// Resolve a single track to its pure-audio version using ytmusicapi or ytScrape.
// Proactively searches for "Topic" channels or high-quality official audio
// to ensure the Host receives an embeddable, high-quality ID from the start.
async function resolveTrackAudio(item) {
  if (!item || item._audioResolved) return;
  item._audioResolved = true;

  try {
    const query = item.artist ? `"${item.artist}" "${item.title}"` : `"${item.title}"`;

    // Priority 1: Python Microservice (ytmusicapi) — The ONLY source for guaranteed ATVs
    if (ytmusicReady) {
      try {
        const { data: songs } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/songs`, {
          params: { q: query, limit: 10, filter: 'songs' },
          timeout: 8000,
        });
        
        // Find the "Gold" ATV version
        const atv = (songs || []).find(s => s.videoType === 'MUSIC_VIDEO_TYPE_ATV' && s.videoId);
        if (atv) {
          console.log(`🎵 [ATV RESOLVE] Studio Audio found: "${item.title}" → ${atv.videoId}`);
          item.trackId = atv.videoId;
          return;
        }
      } catch (ytmErr) {
        console.warn(`[ATV RESOLVE] Python service failed: ${ytmErr.message}`);
      }
    }

    // Priority 2: Scraper — Falling back to Topic channel search if Python ATV fails
    try {
      const results = await ytScrape.GetListByKeyword(query, false, 10);
      const videos = (results.items || [])
        .filter(v => v.type === 'video' && v.id && !isVevoChannel(v.channelTitle))
        .sort((a, b) => scoreYtScrapeItem(b) - scoreYtScrapeItem(a));

      if (videos.length > 0) {
        const best = videos[0];
        if (best.id !== item.trackId) {
          console.log(`🎵 [ATV RESOLVE] Scraper found high-quality fallback: "${item.title}" → ${best.id}`);
          item.trackId = best.id;
        }
      }
    } catch (scrapeErr) {}
  } catch (err) {
    console.warn(`[ATV RESOLVE] Error for "${item.title}":`, err.message);
  }
}// Pre-warm: resolve the top N queue items in the background while the current song plays.
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

function markTrackAsPlayed(trackOrId, manualBlacklist = false) {
  const trackId = typeof trackOrId === 'string' ? trackOrId : trackOrId?.trackId;
  if (!trackId) return;

  // Track recently played so the same song doesn't repeat within 30 minutes.
  // Songs are NOT removed from the pool — the pool stays full and cycles naturally.
  recentlyPlayed.set(trackId, Date.now());

  // Update session history
  const seedTrack = typeof trackOrId === 'object' ? trackOrId : playlistCache.bar.find(t => t.trackId === trackId);
  if (seedTrack?.artist && seedTrack?.title) {
    playedSessionHistory.add(`${seedTrack.artist} - ${seedTrack.title}`);
  }

  // Manual blacklist only — admin explicitly removed this track
  if (manualBlacklist && seedTrack?.artist && seedTrack?.title) {
    const entry = `${seedTrack.artist} - ${seedTrack.title}`;
    for (const [moodId] of moodPoolCache.entries()) {
      if (!moodBlacklist.has(moodId)) moodBlacklist.set(moodId, new Set());
      moodBlacklist.get(moodId).add(entry);
    }
    // Also remove from pool sources on manual blacklist
    const sourcesToPrune = ['moods', 'charts', 'smart', 'genre', 'artist'];
    for (const src of sourcesToPrune) {
      if (Array.isArray(poolSources[src])) {
        poolSources[src] = poolSources[src].filter(t => t.trackId !== trackId);
      }
    }
    for (const [moodId, tracks] of moodPoolCache.entries()) {
      moodPoolCache.set(moodId, tracks.filter(t => t.trackId !== trackId));
    }
    mergePool();
    saveMoodBlacklist();
    console.log(`🚫 MANUAL BLACKLIST: ${entry}`);
  }

  // Track recent artists for spread enforcement in fetchRecommendations
  const artist = seedTrack?.artist;
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

// ─── Search cache ────────────────────────────────────────────────────────────
// Keyed by normalized query string. Entries expire after 1 hour.
// Avoids re-hitting YouTube Data API for repeated searches (saves 101 units/hit).
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const searchCache = new Map(); // query → { tracks, expiresAt }

function searchCacheGet(query) {
  const entry = searchCache.get(query);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { searchCache.delete(query); return null; }
  return entry.tracks;
}

function searchCacheSet(query, tracks) {
  searchCache.set(query, { tracks, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
}

// ─── Search ───────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query required' });

  const normalizedQ = q.trim().toLowerCase();

  // 1. Cache hit — free
  const cached = searchCacheGet(normalizedQ);
  if (cached) {
    console.log(`🔍 [Search] cache hit for: "${q.trim()}"`);
    return res.json(cached);
  }

  try {
    let tracks = [];

    // PRIMARY: ytmusicapi — free, no quota.
    //   Returns YouTube Music catalog items which are embeddable on all domains.
    //   Prioritizes high-quality studio audio (ATV) now that player.html identity is clean.
    if (ytmusicReady) {
      try {
        const { data: songs } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/songs`, {
          params: { q: q.trim(), limit: 20, filter: 'songs' },
          timeout: 10000,
        });
        
        // We now ACCEPT ATVs because they work on the new player identity!
        let candidates = (songs || []).filter(s => s.videoId && s.duration);
        
        if (candidates.length) {
          tracks = candidates.map(mapYtmSongToTrack).filter(t => isValidSongDuration(t.duration));
          console.log(`🔍 [Search] ytmusicapi: ${tracks.length} tracks for "${q.trim()}" (including ATVs)`);
        }
      } catch (ytmErr) {
        console.warn('Search: ytmusicapi failed:', ytmErr.message);
      }
    }

    // FALLBACK 1: youtube-search-api — free, no API key, returns regular YouTube results.
    //   Only used if ytmusicapi is down. Filters VEVO (domain-restricted) + uses ytVideoDetails (1 unit).
    if (!tracks.length) {
      try {
        const results = await ytScrape.GetListByKeyword(q.trim(), false, 20);
        const allVideos = (results.items || []).filter(item => item.type === 'video' && item.id && !item.isLive);
        const vevoBlocked = allVideos.filter(item => isVevoChannel(item.channelTitle));
        if (vevoBlocked.length) console.log(`[Search] Filtered ${vevoBlocked.length} VEVO result(s): ${vevoBlocked.map(i => i.channelTitle).join(', ')}`);
        const scraped = allVideos
          .filter(item => !isVevoChannel(item.channelTitle))
          .sort((a, b) => scoreYtScrapeItem(b) - scoreYtScrapeItem(a));
        if (scraped.length) {
          try {
            const details = await ytVideoDetails(scraped.map(item => item.id)); // 1 unit
            details.sort((a, b) => scoreYtItem(b) - scoreYtItem(a));
            tracks = details.map(mapVideoItemToTrack).filter(t => isValidSongDuration(t.duration));
            console.log(`🔍 [Search] youtube-search-api fallback: ${tracks.length} tracks for "${q.trim()}"`);
          } catch (validateErr) {
            console.warn('Search: ytVideoDetails failed (quota?):', validateErr.message);
          }
        }
      } catch (scrapeErr) {
        console.warn('Search: youtube-search-api also failed:', scrapeErr.message);
      }
    }

    // FALLBACK 2: YouTube Data API — 101 units, absolute last resort
    if (!tracks.length) {
      if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') {
        return res.status(500).json({ error: 'No search backend available' });
      }
      console.log(`🔍 [Search] all free methods failed, using YouTube Data API (101 units) for: "${q.trim()}"`);
      const items = await ytSearch(q.trim(), 15);
      const videoIds = items.map(i => i.id?.videoId).filter(Boolean);
      if (videoIds.length) {
        const details = await ytVideoDetails(videoIds);
        details.sort((a, b) => scoreYtItem(b) - scoreYtItem(a));
        tracks = details.map(mapVideoItemToTrack).filter(t => isValidSongDuration(t.duration));
      }
    }

    searchCacheSet(normalizedQ, tracks);
    res.json(tracks);
  } catch (err) {
    console.error('Search error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/api/resolve-alternate', async (req, res) => {
  const { trackId, title, artist, failedIds = [] } = req.body;
  if (!trackId || !title) return res.status(400).json({ error: 'trackId and title required' });

  console.log(`🔍 [Resolving Alternate] for: ${title} - ${artist} (Original: ${trackId}, Failed: ${failedIds.length})`);

  try {
    const blockedIds = new Set([trackId, ...failedIds]);
    const query = artist ? `"${artist}" "${title}"` : `"${title}"`;
    let candidateId = null;

    console.log(`[resolve-alternate] Blocking ${blockedIds.size} failed/original IDs:`, Array.from(blockedIds));

    // Priority 1: Python Microservice (ytmusicapi) — The "Gold" standard for embeddable audio
    if (ytmusicReady) {
      try {
        const { data: songs } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/songs`, {
          params: { q: query, limit: 15, filter: 'songs' },
          timeout: 8000,
        });
        // Find an ATV (Audio Track Version) that we haven't already failed on
        const atv = (songs || []).find(s => s.videoType === 'MUSIC_VIDEO_TYPE_ATV' && s.videoId && !blockedIds.has(s.videoId));
        if (atv) {
          candidateId = atv.videoId;
          console.log(`✅ [resolve-alternate] Python found ATV: ${candidateId}`);
        }
      } catch (ytmErr) {
        console.warn(`[resolve-alternate] Python service failed: ${ytmErr.message}`);
      }
    }

    // Priority 2: Scraper (youtube-search-api) — Looking for "Topic" channels
    if (!candidateId) {
      try {
        const results = await ytScrape.GetListByKeyword(query, false, 15);
        const videos = (results.items || [])
          .filter(v => v.type === 'video' && v.id && !blockedIds.has(v.id) && !isVevoChannel(v.channelTitle))
          .sort((a, b) => scoreYtScrapeItem(b) - scoreYtScrapeItem(a));

        if (videos.length > 0) {
          candidateId = videos[0].id;
          console.log(`✅ [resolve-alternate] Scraper found: ${candidateId} (${videos[0].channelTitle})`);
        }
      } catch (scrapeErr) {
        console.warn(`[resolve-alternate] Scraper failed: ${scrapeErr.message}`);
      }
    }

    if (!candidateId) return res.status(404).json({ error: 'No suitable alternate found' });

    console.log(`✅ [Resolved Alternate] found: ${candidateId} for ${title}`);

    // Sync server state
    if (targetTrack && targetTrack.trackId === trackId) targetTrack.trackId = candidateId;
    if (currentTrack && currentTrack.trackId === trackId) currentTrack.trackId = candidateId;

    res.json({ trackId: candidateId });
  } catch (err) {
    console.error('Resolve alternate error:', err.message);
    res.status(404).json({ error: 'Resolve failed' });
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
    smartFillEnabled,
    rollingDiscoveryEnabled,
    aiDjEnabled,
    aiDjVoice,
    discoveryProgress,
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
      smart:  { total: poolSources.smart.length },
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

app.put('/api/pool/smartfill', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  smartFillEnabled = !!enabled;
  if (!smartFillEnabled) {
    poolSources.smart = [];
    mergePool();
  }
  saveMetadataCache();
  res.json({ success: true, smartFillEnabled });
});

app.put('/api/pool/rolling', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  rollingDiscoveryEnabled = !!enabled;
  saveMetadataCache();
  res.json({ success: true, rollingDiscoveryEnabled });
});

app.put('/api/pool/mode', requireAdmin, (req, res) => {
  const { mode } = req.body;
  if (!['playlist', 'discovery', 'both'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be playlist, discovery, or both' });
  }
  poolMode = mode;
  mergePool();
  saveMetadataCache();
  res.json({ success: true, mode, totalInPool: playlistCache.bar.length });
});

app.put('/api/settings/aidj', requireAdmin, (req, res) => {
  const { enabled, voice } = req.body;
  if (typeof enabled !== 'undefined') aiDjEnabled = !!enabled;
  if (voice) aiDjVoice = voice;
  broadcast();
  res.json({ success: true, aiDjEnabled, aiDjVoice });
});

app.put('/api/pool/ratio', requireAdmin, (req, res) => {
  const ratio = parseInt(req.body.ratio);
  if (isNaN(ratio) || ratio < 0 || ratio > 100) {
    return res.status(400).json({ error: 'ratio must be 0–100' });
  }
  artistDiscoveryRatio = ratio;
  mergePool();
  saveMetadataCache();
  res.json({ success: true, artistDiscoveryRatio, totalInPool: playlistCache.bar.length });
});

app.get('/api/pool/moods', requireAdmin, (req, res) => {
  res.json(AVAILABLE_MOODS.map(m => ({ ...m, active: activeMoodIds.has(m.id) })));
});

app.post('/api/pool/moods/rebuild/custom', requireAdmin, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  // Concurrency Lock
  const customMoodId = 'custom_vibe';
  if (refillingMoodIds.has(customMoodId)) {
    return res.status(429).json({ error: 'A custom build is already in progress' });
  }
  refillingMoodIds.add(customMoodId);

  // 1. Clear existing mood state to make room for custom vibe
  activeMoodIds.clear();
  moodPoolCache.clear();
  
  // 2. Trigger building
  console.log(`✨ AI-DJ: Building pool from CUSTOM PROMPT: "${prompt}"`);
  res.json({ success: true, message: 'Custom build started' });

  // Run in background
  try {
    discoveryProgress = { active: true, current: 0, target: 25, moodName: 'Custom Vibe' };
    broadcast();

    // Create a virtual mood object for refill support
    const virtualMood = { id: customMoodId, name: 'Custom Vibe', description: prompt };
    // Temporarily add to AVAILABLE_MOODS so refill can find the description
    if (!AVAILABLE_MOODS.find(m => m.id === customMoodId)) {
      AVAILABLE_MOODS.push(virtualMood);
    } else {
      // Update description if it already exists
      const existing = AVAILABLE_MOODS.find(m => m.id === customMoodId);
      existing.description = prompt;
    }

    const fullPrompt = `You are a world-class DJ and music curator. \nUSER REQUEST: ${prompt}\nGive me 30 tracks that fit this vibe perfectly.`;
    const suggestions = await generateTracksWithGemini(fullPrompt, customMoodId);
    
    if (suggestions.length > 0) {
      const moodCollected = [];
      const seenLocal = new Set();
      let moodAdded = 0;

      for (const s of suggestions) {
        if (moodAdded >= 25) break;
        const winner = await findBestYouTubeMatch(s);
        if (winner && !seenLocal.has(winner.id)) {
          const track = mapVideoItemToTrack(winner);
          if (isValidSongDuration(track.duration) && isPoolEligible(track)) {
            seenLocal.add(track.trackId);
            moodCollected.push({ ...track, source: 'moods' });
            moodAdded++;
            discoveryProgress.current = moodAdded;
            
            // Real-time updates
            moodPoolCache.set(customMoodId, moodCollected);
            activeMoodIds.add(customMoodId); // keep track of this for refills
            mergePool();
            broadcast();
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (err) {
    console.error('Custom prompt build failed:', err.message);
  } finally {
    refillingMoodIds.delete(customMoodId);
    discoveryProgress = { active: false, current: 0, target: 0, moodName: '' };
    broadcast();
  }
});

app.put('/api/pool/moods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const mood = AVAILABLE_MOODS.find(m => m.id === id);
  if (!mood) return res.status(404).json({ error: 'Unknown mood' });
  const { active } = req.body;
  if (active) activeMoodIds.add(id);
  else activeMoodIds.delete(id);

  // Reset smart pool on mood change to prevent genre bleed
  poolSources.smart = [];

  // We no longer buildCacheFromMoods automatically. 
  // User must click "Populate" in Admin UI.
  mergePool();
  saveMetadataCache();
  res.json({ success: true, moodId: id, active, totalInPool: playlistCache.bar.length });
});

app.post('/api/pool/moods/populate', requireAdmin, async (req, res) => {
  if (activeMoodIds.size === 0) return res.status(400).json({ error: 'No moods selected' });

  // Concurrency Lock
  const selectedMoodIds = Array.from(activeMoodIds);
  if (selectedMoodIds.some(id => refillingMoodIds.has(id))) {
    return res.status(429).json({ error: 'A mood population or refill is already in progress' });
  }
  selectedMoodIds.forEach(id => refillingMoodIds.add(id));

  const selectedMoods = selectedMoodIds.map(id => AVAILABLE_MOODS.find(m => m.id === id)).filter(Boolean);
  const moodNames = selectedMoods.map(m => m.name).join(' + ');
  const moodDescriptions = selectedMoods.map(m => m.description).filter(Boolean).join('\n');

  console.log(`✨ AI-DJ: Populating BLENDED mood pool for: ${moodNames}...`);
  res.json({ success: true, message: `Starting build for ${moodNames}` });

  try {
    const TARGET_COUNT = 25;
    discoveryProgress = { active: true, current: 0, target: TARGET_COUNT, moodName: moodNames };
    broadcast();

    // 1. Generate blended prompt
    let prompt = `You are a world-class DJ and curator for a trendy bar. \nI need a cohesive, blended set of tracks that perfectly combines these vibes: \n\n${moodNames}`;
    if (moodDescriptions) prompt += `\n\nSpecific vibe details:\n${moodDescriptions}`;
    prompt += `\n\nGive me ${TARGET_COUNT + 5} high-quality, essential tracks that bridge these moods naturally. Ensure variety but keep the flow perfect for a bar.`;

    // 2. Fetch suggestions
    // Use the first mood ID as a context anchor for blacklist, or null
    const contextId = selectedMoods.length === 1 ? selectedMoods[0].id : null;
    const suggestions = await generateTracksWithGemini(prompt, contextId);

    if (suggestions.length > 0) {
      const blendedTracks = [];
      const seenLocal = new Set();
      let moodAdded = 0;

      for (const s of suggestions) {
        if (moodAdded >= TARGET_COUNT) break;
        const winner = await findBestYouTubeMatch(s);
        if (winner && !seenLocal.has(winner.id)) {
          const track = mapVideoItemToTrack(winner);
          if (isValidSongDuration(track.duration) && isPoolEligible(track)) {
            seenLocal.add(track.trackId);

            const enrichedTrack = { 
              ...track, 
              source: 'moods',
              bpm: s.bpm || null,
              mood_party: s.energy || null,
              danceability: s.danceability || null,
              valence: s.valence || null,
              key: s.musical_key || null,
              aiGenerated: true
            };

            blendedTracks.push(enrichedTrack);
            moodAdded++;
            discoveryProgress.current = moodAdded;

            for (const mood of selectedMoods) {
               moodPoolCache.set(mood.id, blendedTracks);
            }

            mergePool();
            broadcast();
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (err) {
    console.error('Mood population failed:', err.message);
  } finally {
    selectedMoodIds.forEach(id => refillingMoodIds.delete(id));
    discoveryProgress = { active: false, current: 0, target: 0, moodName: '' };
    saveMetadataCache();
    broadcast();
  }
});app.post('/api/pool/csv', requireAdmin, (req, res) => {
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
    saveMetadataCache();
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
  saveMetadataCache();
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
  
  // Use markTrackAsPlayed with manual=true to trigger the blacklist
  markTrackAsPlayed(trackId, true);
  
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
  const item = queue.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  
  queue = queue.filter(i => i.id !== req.params.id);
  // Manual remove from queue = add to blacklist
  markTrackAsPlayed(item, true);
  
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

  // 1. Handle Natural Advance (from crossfade or end of track)
  if (naturalAdvance) {
    // Check if it's the target track we just moved
    if (targetTrack && targetTrack.trackId === trackId) {
      currentTrack = targetTrack;
      targetTrack = null;
      markTrackAsPlayed(trackId);
      await ensureQueueHasUpcomingTrack();
      resolveQueueAudio(2).catch(() => {});
      broadcast();
      return res.json({ success: true, fromTarget: true });
    }
    
    // Check if it's still in the queue (e.g. host jumped ahead)
    const queuedTrack = queue.find(item => item.trackId === trackId);
    if (queuedTrack) {
      currentTrack = queuedTrack;
      targetTrack  = null;
      queue = queue.filter(item => item.trackId !== trackId);
      markTrackAsPlayed(trackId);
      await ensureQueueHasUpcomingTrack();
      resolveQueueAudio(2).catch(() => {});
      broadcast();
      return res.json({ success: true, fromQueue: true });
    }
  }

  // 2. Standard Sync / Manual Play
  if (targetTrack && targetTrack.trackId === trackId) {
    currentTrack = targetTrack;
    targetTrack = null; // Clear target once matched
  } else if (currentTrack && currentTrack.trackId === trackId) {
    // Already in sync.
  } else {
    const queuedTrack = queue.find(item => item.trackId === trackId);
    if (queuedTrack) {
      currentTrack = queuedTrack;
      targetTrack = null;
      queue = queue.filter(item => item.trackId !== trackId);
    } else {
      console.log(`⚠️ [ACK] Host playing unknown trackId: ${trackId} - adopting metadata`);
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
    if (adoptTarget || !targetTrack) targetTrack = null; 
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
  loadMetadataCache();
  loadMoodBlacklist();
  await startYTMusicService();
  rebuildPool().catch(err => console.warn('Startup pool build failed:', err.message));

  // Every 10 minutes, hunt for new tracks based on the current vibe - SKIP GEMINI
  setInterval(() => {
    console.log('🕒 Scheduled Smart Discovery running (skipping AI vetting)...');
    fetchSmartDiscovery(null, 1, true).catch(() => {});
  }, 10 * 60 * 1000);
});

// Graceful shutdown — kill the Python child process so it doesn't linger
process.on('SIGINT',  () => { ytmusicProcess?.kill(); process.exit(0); });
process.on('SIGTERM', () => { ytmusicProcess?.kill(); process.exit(0); });
