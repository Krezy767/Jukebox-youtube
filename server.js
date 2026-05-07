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

function getNonPaidGeminiKey() {
  return process.env.GEMINI_VOICE_KEY || null;
}

// ─── Gemini Lab: Diagnostic Endpoint ─────────────────────────────────────────
app.post('/api/test/gemini', async (req, res) => {
  const { modelId, apiKey, count, prompt, systemInstruction, temperature, useTurbo, freshness } = req.body;
  
  // Use explicit key if provided. Otherwise stay on the non-paid key path only.
  let key = apiKey;
  if (!key) {
    key = getNonPaidGeminiKey();
  }
  
  if (!key) return res.status(400).json({ error: 'No API key provided' });
  
  const userPrompt = `${prompt}\n\nReturn EXACTLY ${count} tracks as a JSON array. ${freshness ? 'Focus on LATEST HITS and NEW RELEASES from late 2024, 2025, and 2026.' : ''}`;
  const sysPrompt = systemInstruction || "You are a professional music curator. Return only a valid JSON array of objects.";

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`,
      {
        system_instruction: { parts: [{ text: sysPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { 
          responseMimeType: 'application/json',
          temperature: temperature !== undefined ? temperature : 0.7 
        }
      },
      { timeout: 60000 }
    );

    let resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const usage = data?.usageMetadata || { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
    
    // Cost calculation (April 2026 pricing)
    let estCost = 0;
    const isLite = modelId.includes('lite');
    if (isLite) {
      estCost = (usage.promptTokenCount * 0.0000001) + (usage.candidatesTokenCount * 0.0000004);
    } else {
      estCost = (usage.promptTokenCount * 0.00000025) + (usage.candidatesTokenCount * 0.0000015);
    }

    const tracks = JSON.parse(resultText);
    res.json({ 
      success: true, 
      model: modelId,
      tracks: tracks,
      usage: {
        prompt: usage.promptTokenCount,
        completion: usage.candidatesTokenCount,
        total: usage.totalTokenCount,
        estimatedCost: estCost.toFixed(6)
      }
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

function normalizeLabText(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreLabType(videoType = '') {
  if (videoType === 'MUSIC_VIDEO_TYPE_ATV') return 8;
  if (videoType === 'MUSIC_VIDEO_TYPE_OMV') return -3;
  if (videoType === 'MUSIC_VIDEO_TYPE_UGC') return -5;
  return 0;
}

function scoreChartBoostCandidate(track, seed, anchorArtists, radioArtists, chartArtists, radioRank = 999, isChartTrack = false) {
  const artist = normalizeLabText(track.artist);
  const title = normalizeLabText(track.title);
  const seedArtist = normalizeLabText(seed.artist);
  const seedTitle = normalizeLabText(seed.title);
  let score = scoreLabType(track.videoType);

  if (radioRank < 999) score += Math.max(0, 18 - radioRank * 2);
  if (isChartTrack) score += 6;
  if (artist && chartArtists.has(artist)) score += 7;

  if (artist && artist === seedArtist) score -= 5;
  else if (artist && anchorArtists.has(artist)) score += 5;
  else if (artist && radioArtists.has(artist)) score += 4;
  else if (!isChartTrack) score += 1;
  else score -= 2;

  if (title && title === seedTitle && artist === seedArtist) score -= 100;
  if (/\b(remix|sped up|slowed|instrumental|karaoke|tribute|cover)\b/.test(title)) score -= 4;
  if (/\b(live|acoustic)\b/.test(title)) score -= 2;

  return score;
}

async function fetchYtMusicRadio(videoId, limit = 11) {
  const { data } = await axios.get(`${YTMUSIC_SERVICE_URL}/radio`, {
    params: { videoId, limit },
    timeout: 15000,
  });
  return Array.isArray(data) ? data : [];
}

async function fetchYtMusicPlaylists(query) {
  const { data } = await axios.get(`${YTMUSIC_SERVICE_URL}/search/playlists`, {
    params: { q: query },
    timeout: 15000,
  });
  return Array.isArray(data) ? data : [];
}

async function fetchYtMusicPlaylistTracks(playlistId, limit = 60) {
  const { data } = await axios.get(`${YTMUSIC_SERVICE_URL}/playlist/tracks`, {
    params: { id: playlistId, limit },
    timeout: 20000,
  });
  return Array.isArray(data) ? data : [];
}

async function fetchChartTracksForLab(limitPerPlaylist = 60) {
  const chartTracks = [];
  const chartSources = [];
  const seenIds = new Set();

  for (const query of CHART_PLAYLIST_QUERIES) {
    try {
      const playlists = await fetchYtMusicPlaylists(query);
      if (!playlists.length) continue;
      const playlist = playlists[0];
      chartSources.push({ query, name: playlist.name, playlistId: playlist.playlistId });

      const tracks = await fetchYtMusicPlaylistTracks(playlist.playlistId, limitPerPlaylist);
      for (const track of tracks) {
        if (!track?.videoId || seenIds.has(track.videoId)) continue;
        const mapped = mapYtmSongToTrack(track);
        if (!isValidSongDuration(mapped.duration) || !isPoolEligible(mapped)) continue;
        seenIds.add(track.videoId);
        chartTracks.push({ ...track, _chartSource: playlist.name });
      }
    } catch (err) {
      console.warn(`⚠️ [Radio Lab] Chart playlist fetch failed for "${query}":`, err.message);
    }
  }

  return { chartTracks, chartSources };
}

function buildChartBoostedCandidates(seed, radioTracks, chartTracks, limit = 18) {
  if (!radioTracks.length) return [];

  const radioResults = radioTracks.slice(1);
  const radioArtists = new Set(radioResults.map(t => normalizeLabText(t.artist)).filter(Boolean));
  const anchorArtists = new Set(
    [seed.artist, ...radioResults.slice(0, 4).map(t => t.artist)].map(normalizeLabText).filter(Boolean)
  );
  const chartArtists = new Set(chartTracks.map(t => normalizeLabText(t.artist)).filter(Boolean));

  const candidateMap = new Map();
  radioResults.forEach((track, index) => {
    if (!track?.videoId) return;
    candidateMap.set(track.videoId, {
      ...track,
      _score: scoreChartBoostCandidate(track, seed, anchorArtists, radioArtists, chartArtists, index, false),
      reason: `Radio rank #${index + 1}`,
      source: 'radio',
    });
  });

  for (const track of chartTracks) {
    if (!track?.videoId || candidateMap.has(track.videoId)) continue;
    const artistKey = normalizeLabText(track.artist);
    if (!artistKey) continue;

    const inLane = anchorArtists.has(artistKey) || radioArtists.has(artistKey);
    if (!inLane) continue;

    const score = scoreChartBoostCandidate(track, seed, anchorArtists, radioArtists, chartArtists, 999, true);
    if (score <= 0) continue;

    candidateMap.set(track.videoId, {
      ...track,
      _score: score,
      reason: `Current chart boost from ${track._chartSource}`,
      source: 'chart',
    });
  }

  const sortedCandidates = Array.from(candidateMap.values()).sort((a, b) => b._score - a._score);
  const usedArtists = new Map();
  const boostedResults = [];

  for (const candidate of sortedCandidates) {
    if (boostedResults.length >= limit) break;
    const artistKey = normalizeLabText(candidate.artist);
    const countForArtist = usedArtists.get(artistKey) || 0;
    const maxPerArtist = artistKey === normalizeLabText(seed.artist) ? 1 : 2;
    if (countForArtist >= maxPerArtist) continue;

    usedArtists.set(artistKey, countForArtist + 1);
    boostedResults.push(candidate);
  }

  return boostedResults;
}

app.get('/api/test/radio', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 11, 30);
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  try {
    const tracks = await fetchYtMusicRadio(videoId, limit);
    res.json(tracks);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/api/test/radio-lab', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 12, 30);
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  try {
    const radioTracks = await fetchYtMusicRadio(videoId, Math.max(limit + 8, 20));
    if (!radioTracks.length) {
      return res.status(404).json({ error: 'No radio tracks found for that videoId' });
    }

    const seed = radioTracks[0];
    const radioResults = radioTracks.slice(1);
    const anchorArtists = new Set(
      [seed.artist, ...radioResults.slice(0, 4).map(t => t.artist)].map(normalizeLabText).filter(Boolean)
    );
    const { chartTracks, chartSources } = await fetchChartTracksForLab(80);
    const boostedCandidates = buildChartBoostedCandidates(seed, radioTracks, chartTracks, limit);
    const boostedResults = boostedCandidates.map(({ _score, _chartSource, ...track }) => ({
      ...track,
      score: _score,
    }));

    res.json({
      seed,
      radio: radioResults,
      boosted: boostedResults,
      debug: {
        chartSources,
        anchorArtists: Array.from(anchorArtists),
        resultArtists: Array.from(new Set(boostedResults.map(t => normalizeLabText(t.artist)).filter(Boolean))),
        chartArtistCount: new Set(chartTracks.map(t => normalizeLabText(t.artist)).filter(Boolean)).size,
        radioCount: radioResults.length,
        boostedCount: boostedResults.length,
      }
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || err.message });
  }
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
const DEEP_SHADOW_CACHE_FILE = path.join(__dirname, 'deep_shadow_cache.json');
const MOOD_BLACKLIST_FILE = path.join(__dirname, 'mood_blacklist.json');

const moodBlacklist = new Map(); // moodId -> Set of blacklisted 'Artist - Title' strings
const refillingMoodIds = new Set(); // mood IDs currently being refilled to prevent concurrent duplicates
let vibeStrictness = 70; // 0-100, controlled by admin panel
let freshnessEnabled = false; // admin toggle for Latest Hits / chart-boosted Ultra-Fill

// 🎤 AI DJ Settings
let aiDjEnabled = false;
let aiDjVoice = 'Zephyr';
const deepShadowCache = new Map(); // videoId -> native Deep Shadow JSON
const deepShadowInFlight = new Map(); // videoId -> Promise

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
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

let geminiDisabledUntil = 0;

async function generateTracksWithGemini(prompt, moodId = null, useTurbo = true, temperature = 0.7, systemInstruction = null, modelOverride = null, forcePaid = false) {
  if (Date.now() < geminiDisabledUntil) {
    console.log('🕒 Gemini is "Cooling Down" due to previous rate limits. Using fallback discovery.');
    return [];
  }

  return _generateTracksWithGeminiSingle(prompt, moodId, 1, 0, 0, GEMINI_MODELS.length - 1, temperature, systemInstruction, modelOverride, forcePaid, useTurbo);
}

function getGeminiKeyPool(useTurbo = true, forcePaid = false, pinnedFallbackKey = null) {
  const primaryKey = process.env.GEMINI_API_KEY;
  const fallback   = process.env.GEMINI_FALLBACK_KEYS || process.env.GEMINI_API_KEYS_FALLBACK || '';
  const fallbackKeys = fallback.split(',').map(k => k.trim()).filter(Boolean);

  // Key routing (voiceKey is reserved exclusively for the live narrator — never touched here):
  //   forcePaid=true        → primary only                      (Seeds path)
  //   useTurbo=false        → fallback keys only                (Gatekeeper path)
  //                           falls through to primary with warn if no fallback configured
  //   default (useTurbo=true) → [primary, ...fallback]          (Discovery path)
  let allKeys;
  if (forcePaid) {
    allKeys = [primaryKey].filter(Boolean);
  } else if (pinnedFallbackKey) {
    allKeys = [pinnedFallbackKey];
  } else if (!useTurbo) {
    if (fallbackKeys.length) {
      allKeys = fallbackKeys;
    } else {
      console.warn('⚠️  Gatekeeper: no GEMINI_API_KEYS_FALLBACK configured — falling back to paid primary key.');
      allKeys = [primaryKey].filter(Boolean);
    }
  } else {
    allKeys = [primaryKey, ...fallbackKeys].filter(Boolean);
  }

  return { allKeys, fallbackKeys, primaryKey };
}

function getGeminiFallbackKeys() {
  return getGeminiKeyPool(false, false).fallbackKeys;
}

async function _generateTracksWithGeminiSingle(prompt, moodId = null, attempt = 1, modelIndex = 0, keyIndex = 0, maxModelIndex = 3, temperature = 0.7, systemInstruction = null, modelOverride = null, forcePaid = false, useTurbo = true, pinnedFallbackKey = null, workerLabel = null) {
  const { allKeys } = getGeminiKeyPool(useTurbo, forcePaid, pinnedFallbackKey);
  const allowModelCascade = !modelOverride;

  if (allKeys.length === 0) return [];
  const currentKey = allKeys[keyIndex % allKeys.length];
  const currentModel = modelOverride || GEMINI_MODELS[modelIndex % GEMINI_MODELS.length];
  const keyLabel = workerLabel || `Key ${keyIndex + 1}/${allKeys.length}`;

  console.log(`🤖 Gemini [${currentModel}] (${keyLabel}): Generating tracks (Attempt ${attempt}, Temp ${temperature})...`);

  let blacklistContext = '';
  if (moodId && moodBlacklist.has(moodId)) {
    const list = Array.from(moodBlacklist.get(moodId)).slice(0, 50);
    if (list.length > 0) {
      blacklistContext = `\nCRITICAL: Do NOT suggest any of these tracks: ${list.join(', ')}.`;
    }
  }

  const sysPrompt = systemInstruction || "You are a professional music curator. Return only a valid JSON array of objects.";
  const fullPrompt = `${prompt}${blacklistContext}\nReturn ONLY a JSON array of objects. \nEach object MUST include: {"artist": "...", "title": "..."}. \nCRITICAL: Ensure all strings are properly escaped. Do NOT include unescaped double quotes inside values. Keep it high-quality and fitting for a bar.`;

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${currentKey}`,
      {
        system_instruction: { parts: [{ text: sysPrompt }] },
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: { 
          responseMimeType: 'application/json',
          temperature: temperature
        }
      },
      { timeout: 30000 }
    );

    let resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    
    // HEURISTIC SANITIZER
    resultText = resultText.replace(/:\s*"([^"]*)"/g, (match, content) => {
      const sanitized = content.replace(/"/g, "'");
      return `: "${sanitized}"`;
    });

    const suggestions = JSON.parse(resultText);

    if (Array.isArray(suggestions)) {
      console.log(`✨ Gemini [${currentModel}] returned ${suggestions.length} items.`);
      return suggestions;
    }
    return [];
  } catch (err) {
    const status = err.response?.status;
    const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message.includes('timeout');
    const pinnedMode = !!pinnedFallbackKey && !forcePaid;
    
    // If Gatekeeper (useTurbo=false) has burned through every fallback key,
    // escalate ONCE to the paid primary rather than failing the whole refill.
    // We flip useTurbo=true and forcePaid=true so the next call uses ONLY the
    // paid key — no second escalation attempt possible.
    const canEscalateToPaid = !useTurbo && !forcePaid && (pinnedMode || keyIndex + 1 >= allKeys.length) && !!process.env.GEMINI_API_KEY;

    if (status === 429) {
      if (attempt <= 2) {
        const waitTime = attempt * 15000;
        console.warn(`🕒 Gemini [${currentModel}] (${keyLabel}) Rate Limited (429). Waiting ${waitTime/1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        return _generateTracksWithGeminiSingle(prompt, moodId, attempt + 1, modelIndex, keyIndex, maxModelIndex, temperature, systemInstruction, modelOverride, forcePaid, useTurbo, pinnedFallbackKey, workerLabel);
      } else if (!pinnedMode && keyIndex + 1 < allKeys.length) {
        console.warn(`🔄 Gemini [${currentModel}] (${keyLabel}) exhausted. Rotating...`);
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, modelIndex, keyIndex + 1, maxModelIndex, temperature, systemInstruction, modelOverride, forcePaid, useTurbo, pinnedFallbackKey, workerLabel);
      } else if (canEscalateToPaid) {
        console.warn(`💳 Gatekeeper: ${keyLabel} exhausted on 429 — escalating to paid primary.`);
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, 0, 0, maxModelIndex, temperature, systemInstruction, modelOverride, true, true, null, `${keyLabel} -> paid`);
      } else {
        geminiDisabledUntil = Date.now() + (10 * 60 * 1000);
      }
    } else if (status === 503 || isTimeout) {
      if (attempt === 1) {
        return _generateTracksWithGeminiSingle(prompt, moodId, attempt + 1, modelIndex, keyIndex, maxModelIndex, temperature, systemInstruction, modelOverride, forcePaid, useTurbo, pinnedFallbackKey, workerLabel);
      } else if (!pinnedMode && keyIndex + 1 < allKeys.length) {
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, modelIndex, keyIndex + 1, maxModelIndex, temperature, systemInstruction, modelOverride, forcePaid, useTurbo, pinnedFallbackKey, workerLabel);
      } else if (allowModelCascade && modelIndex < maxModelIndex) {
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, modelIndex + 1, 0, maxModelIndex, temperature, systemInstruction, modelOverride, forcePaid, useTurbo, pinnedFallbackKey, workerLabel);
      } else if (canEscalateToPaid) {
        console.warn(`💳 Gatekeeper: ${keyLabel} exhausted on ${status || 'timeout'} — escalating to paid primary.`);
        return _generateTracksWithGeminiSingle(prompt, moodId, 1, 0, 0, maxModelIndex, temperature, systemInstruction, modelOverride, true, true, null, `${keyLabel} -> paid`);
      }
    }
    return [];
  }
}

async function runPinnedGatekeeperChunks(chunks, displayName, sysInstruction) {
  if (!chunks.length) return new Set();

  const fallbackKeys = getGeminiFallbackKeys();
  if (!fallbackKeys.length) {
    console.warn('⚠️ [Ultra-Fill] No fallback keys configured for pinned Gatekeeper workers — using sequential paid fallback path.');
    const acceptedIds = new Set();
    for (const chunk of chunks) {
      const chunkStr = chunk.map(t => `${t.artist} - ${t.title}`).join('\n');
      const userPrompt = `VIBE: ${displayName}\n\nLIST TO FILTER:\n${chunkStr}`;
      try {
        const chunkAccepted = await generateTracksWithGemini(userPrompt, null, false, 0.3, sysInstruction);
        if (Array.isArray(chunkAccepted)) {
          chunkAccepted.forEach(s => {
            const sArtist = (s.artist || '').toLowerCase();
            const sTitle = (s.title || '').toLowerCase();
            const match = chunk.find(t => {
              const tArtist = t.artist.toLowerCase();
              const tTitle = t.title.toLowerCase();
              const titleMatch = tTitle.includes(sTitle) || sTitle.includes(tTitle);
              const artistMatch = tArtist.includes(sArtist) || sArtist.includes(tArtist);
              return titleMatch && artistMatch;
            });
            if (match) acceptedIds.add(match.trackId);
          });
        }
      } catch (err) {
        chunk.forEach(t => acceptedIds.add(t.trackId));
      }
    }
    return acceptedIds;
  }

  const acceptedIds = new Set();
  const workerCount = Math.min(chunks.length, fallbackKeys.length);
  let nextChunkIndex = 0;

  async function runWorker(workerIndex) {
    const pinnedKey = fallbackKeys[workerIndex];
    const workerLabel = `Gatekeeper worker ${workerIndex + 1}`;

    while (nextChunkIndex < chunks.length) {
      const chunkIndex = nextChunkIndex++;
      const chunk = chunks[chunkIndex];
      const chunkStr = chunk.map(t => `${t.artist} - ${t.title}`).join('\n');
      const userPrompt = `VIBE: ${displayName}\n\nLIST TO FILTER:\n${chunkStr}`;

      console.log(`🛡️ [Ultra-Fill] ${workerLabel} pinned to fallback key ${workerIndex + 1}/${fallbackKeys.length} processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} tracks)`);

      try {
        const chunkAccepted = await _generateTracksWithGeminiSingle(
          userPrompt,
          null,
          1,
          0,
          0,
          GEMINI_MODELS.length - 1,
          0.3,
          sysInstruction,
          null,
          false,
          false,
          pinnedKey,
          workerLabel
        );

        if (Array.isArray(chunkAccepted)) {
          chunkAccepted.forEach(s => {
            const sArtist = (s.artist || '').toLowerCase();
            const sTitle = (s.title || '').toLowerCase();
            const match = chunk.find(t => {
              const tArtist = t.artist.toLowerCase();
              const tTitle = t.title.toLowerCase();
              const titleMatch = tTitle.includes(sTitle) || sTitle.includes(tTitle);
              const artistMatch = tArtist.includes(sArtist) || sArtist.includes(tArtist);
              return titleMatch && artistMatch;
            });
            if (match) acceptedIds.add(match.trackId);
          });
        }
      } catch (err) {
        chunk.forEach(t => acceptedIds.add(t.trackId));
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(i)));
  return acceptedIds;
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

function saveDeepShadowCache() {
  try {
    fs.writeFileSync(DEEP_SHADOW_CACHE_FILE, JSON.stringify(Object.fromEntries(deepShadowCache), null, 2));
  } catch (err) {
    console.error('Failed to save Deep Shadow cache:', err.message);
  }
}

function loadDeepShadowCache() {
  if (!fs.existsSync(DEEP_SHADOW_CACHE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DEEP_SHADOW_CACHE_FILE, 'utf8'));
    for (const [videoId, analysis] of Object.entries(data)) {
      if (/^[A-Za-z0-9_-]{6,20}$/.test(videoId) && analysis?.sections) {
        deepShadowCache.set(videoId, analysis);
      }
    }
    console.log(`✓ Deep Shadow cache loaded: ${deepShadowCache.size} tracks`);
  } catch (err) {
    console.warn('Failed to load Deep Shadow cache:', err.message);
  }
}

// ─── Pool State ───────────────────────────────────────────────────────────────
let poolMode = 'both'; // 'playlist' | 'discovery' | 'both'
let artistDiscoveryRatio = 50; // 0 = all discovery (charts/genre), 100 = all artist seeds
let smartFillEnabled = true;
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
  saved:  [],  // tracks loaded from a user-saved playlist preset
};

// ─── Saved Playlists (user-curated pool presets) ──────────────────────────────
// Stored on disk so they survive restarts. Separate from moodPoolCache / any
// auto-discovery cache — these only change when the user explicitly saves/edits.
const SAVED_PLAYLISTS_FILE = path.join(__dirname, 'saved_playlists.json');
let savedPlaylists = []; // [{ id, name, createdAt, updatedAt, moods: {genres:[], moods:[]}, tracks: [...] }]

function loadSavedPlaylists() {
  try {
    if (!fs.existsSync(SAVED_PLAYLISTS_FILE)) return;
    const raw = fs.readFileSync(SAVED_PLAYLISTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      savedPlaylists = parsed;
      console.log(`✓ Loaded ${savedPlaylists.length} saved playlist(s) from disk`);
    }
  } catch (err) {
    console.warn('Failed to load saved_playlists.json:', err.message);
  }
}

function persistSavedPlaylists() {
  try {
    fs.writeFileSync(SAVED_PLAYLISTS_FILE, JSON.stringify(savedPlaylists, null, 2));
  } catch (err) {
    console.error('Failed to write saved_playlists.json:', err.message);
  }
}

function findSavedPlaylist(id) {
  return savedPlaylists.find(p => p.id === id);
}

// ─── Available Genres & Moods ──────────────────────────────────────────────────
const AVAILABLE_GENRES = [
  { id: 'house',        name: 'Deep House',    emoji: '🎛️', description: 'Modern deep house, smooth grooves, and sophisticated bar vibes.' },
  { id: 'organichouse', name: 'Organic House', emoji: '🌅', description: 'Textural, melodic, and acoustic-infused house music. Think Stimming or Bedouin.' },
  { id: 'afrohouse',    name: 'Afro House',    emoji: '🥁', description: 'Rhythmic, percussion-heavy house with African influence.' },
  { id: 'jackinhouse',  name: 'Jackin\' House',  emoji: '📼', description: 'Funky, high-energy, and groovy house with a retro touch.' },
  { id: 'hiphop',       name: 'Hip-Hop',       emoji: '🎤' },
  { id: 'rnb',          name: 'R&B',           emoji: '❤️' },
  { id: 'pop',          name: 'Pop',           emoji: '⭐' },
  { id: 'rock',         name: 'Rock',          emoji: '🎸' },
  { id: 'jazz',         name: 'Jazz',          emoji: '🎷' },
  { id: 'croatianeurodance', name: 'Croatian Eurodance', emoji: '🕺', description: '90s and 2000s Croatian Eurodance and dance-pop hits.' },
  { id: 'croatiantrash', name: 'Croatian Treš', emoji: '🇭🇷', description: 'Late 90s/Early 2000s high-energy Croatian dance-pop (Cro-Dance).' },
  { id: 'brazilian',    name: 'Brazilian',     emoji: '🇧🇷', description: 'Brazilian Funk Carioca (Baile Funk) and infectious beats.' },
  { id: 'argentinian',  name: 'Argentinian',   emoji: '🇦🇷', description: 'Argentinian Cumbia Villera, RKT, and modern Trap.' },
  { id: 'croatian',     name: 'Croatian',      emoji: '🇭🇷', description: 'Croatian Pop-Rock and contemporary bar-friendly hits.' },
  { id: 'phonk',        name: 'Phonk',         emoji: '🔊', description: 'High-energy Phonk, Drift Phonk, and heavy bass textures.' },
  { id: 'cajke',        name: 'Cajke',         emoji: '🇭🇷', description: "Focus on modern Balkan TurboFolk and the specific niche known as 'Cajke.' These are high-energy, catchy club tracks from Serbia, Croatia, and Bosnia. Think modern production, heavy synth-leads, and high-energy vocals." },
];

const AVAILABLE_MOODS = [
  { id: 'party',     name: 'Party',      emoji: '🎉' },
  { id: 'chill',     name: 'Chill',      emoji: '😌' },
  { id: 'feelgood',  name: 'Feel Good',  emoji: '😊' },
  { id: 'workout',   name: 'Workout',    emoji: '💪' },
  { id: 'summer',    name: 'Summer',     emoji: '☀️' },
  { id: 'romance',   name: 'Romance',    emoji: '💕' },
  { id: 'focus',     name: 'Focus',      emoji: '🎯' },
  { id: 'throwback', name: 'Throwback',  emoji: '⏮️' },
];

// Active selections
let activeGenreIds = new Set();
// activeMoodIds and moodPoolCache are already declared above
const discoveryPool = []; 

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

function parseDurationToMs(duration) {
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    // Internal tracks use ms; ytmusicapi wire format uses seconds.
    return duration > 1000 ? Math.round(duration) : Math.round(duration * 1000);
  }
  if (typeof duration === 'string') {
    const trimmed = duration.trim();
    if (!trimmed) return 0;
    if (/^PT/i.test(trimmed)) return parseISO8601Duration(trimmed);
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':').map(n => parseInt(n, 10));
      if (parts.some(n => Number.isNaN(n))) return 0;
      if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
      if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric > 1000 ? Math.round(numeric) : Math.round(numeric * 1000);
  }
  return 0;
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

    // SMART SELECTION: Find a version with a "reasonable" duration (avoid 1-hour loops)
    const reasonable = songs.find(s => {
      const d = s.duration || 0;
      return d >= 90 && d <= 600;
    });

    const best = reasonable || songs[0];
    if (!best?.videoId) return null;

    let durationSeconds = 0;
    if (typeof best.duration === 'number') {
      durationSeconds = best.duration;
    } else if (typeof best.duration === 'string' && best.duration.includes(':')) {
      const parts = best.duration.split(':').map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n));
      if (parts.length === 2) durationSeconds = parts[0] * 60 + parts[1];
      if (parts.length === 3) durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    const durationLabel = durationSeconds > 0 ? `${Math.round(durationSeconds / 60)} min` : 'duration unknown';
    console.log(`  ✅ [YouTube] Found match: "${best.title}" by ${best.artist} (${durationLabel})`);

    return {
      id: best.videoId,
      snippet: {
        title: best.title,
        channelTitle: best.artist,
        thumbnails: { default: { url: best.albumArt } }
      },
      contentDetails: { duration: `PT${durationSeconds || 0}S` }
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

function isLikelyShortsTrack(track = {}) {
  const title = `${track.title || ''} ${track.album || ''}`.toLowerCase();
  return /\b(shorts?|clip|preview|snippet|teaser)\b/.test(title);
}

function isQueueEligibleTrack(track = {}) {
  const durationMs = parseDurationToMs(track.duration);
  return !!track.trackId &&
    isValidSongDuration(durationMs) &&
    !isLikelyShortsTrack(track);
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
    // Include ALL discovery tracks from active combined selection via the cache
    const discoveryTracks = [];
    const comboKey = [...activeGenreIds, ...activeMoodIds].sort().join('+');
    
    if (moodPoolCache.has(comboKey)) {
       const cached = moodPoolCache.get(comboKey) || [];
       discoveryTracks.push(...cached.map(t => ({ ...t, source: 'moods' })));
    }
    
    // Update the source tracker for UI/Logs
    poolSources.moods = discoveryTracks;

    // Fallback to charts only if no genres or moods are active
    if (activeGenreIds.size === 0 && activeMoodIds.size === 0) {
      discoveryTracks.push(...poolSources.charts.map(t => ({ ...t, source: 'charts' })));
    }

    // Combined pool of all available discovery methods
    const autoPool = [
      ...poolSources.saved.map(t => ({ ...t, source: 'saved' })),
      ...poolSources.artist.map(t => ({ ...t, source: 'artist' })),
      ...poolSources.smart.map(t => ({ ...t, source: 'smart' })),
      ...discoveryTracks
    ];

    for (const track of autoPool) {
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
  const durationMs = parseDurationToMs(song.duration);

  return {
    trackId:     song.videoId,
    title:       song.title    || 'Unknown',
    artist:      song.artist   || 'Unknown',
    album:       song.album    || '',
    albumArt:    song.albumArt || null,
    explicit:    false,
    duration:    durationMs,
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

async function fetchSmartDiscovery() {
  if (!smartFillEnabled) return;

  const seed = currentTrack || playlistCache.bar[playlistCache.bar.length - 1];
  if (!seed?.trackId) {
    console.log('🕒 [Smart-Fill] No seed track available, skipping tick');
    return;
  }

  const genres = Array.from(activeGenreIds).map(id => AVAILABLE_GENRES.find(g => g.id === id)?.name).filter(Boolean);
  const moods  = Array.from(activeMoodIds).map(id => AVAILABLE_MOODS.find(m => m.id === id)?.name).filter(Boolean);
  const hasFilter = genres.length > 0 || moods.length > 0;

  console.log(`🕒 [Smart-Fill] Radio seed: "${seed.artist} - ${seed.title}"${hasFilter ? ` | genres=[${genres.join('+')}] moods=[${moods.join('+')}]` : ''}`);

  let radioTracks;
  try {
    const { data } = await axios.get(`${YTMUSIC_SERVICE_URL}/radio`, {
      params: { videoId: seed.trackId, limit: 20 },
      timeout: 10000,
    });
    radioTracks = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('⚠️ [Smart-Fill] Radio fetch failed:', err.message);
    return;
  }

  if (!radioTracks.length) {
    console.log('🕒 [Smart-Fill] Radio returned no tracks');
    return;
  }

  const seenIds = new Set();
  Object.values(poolSources).forEach(bucket => bucket.forEach(t => seenIds.add(t.trackId)));
  seenIds.add(seed.trackId);

  const candidates = [];
  for (const rt of radioTracks.slice(1)) {
    if (!rt.videoId || seenIds.has(rt.videoId)) continue;
    const track = mapYtmSongToTrack(rt);
    if (!isValidSongDuration(track.duration) || !isPoolEligible(track)) continue;
    candidates.push({ ...track, source: 'smart' });
    seenIds.add(rt.videoId);
  }

  if (!candidates.length) {
    console.log('🕒 [Smart-Fill] All radio tracks already in pool');
    return;
  }

  let accepted = candidates;
  if (hasFilter) {
    const vibeParts = [];
    if (genres.length) vibeParts.push(`GENRE (PRIORITY — must match): ${genres.join(' + ')}`);
    if (moods.length)  vibeParts.push(`mood (secondary — just needs to be adjacent, not hostile): ${moods.join(' + ')}`);
    const vibe = vibeParts.join('\n');
    const chunkStr = candidates.map(t => `${t.artist} - ${t.title}`).join('\n');
    const userPrompt = `VIBE:\n${vibe}\n\nLIST TO FILTER:\n${chunkStr}`;
    const sysInstruction = `You are an "Impostor Filter" for a bar DJ refreshing the background pool. GENRE has priority — a track must fit the listed genres. Mood is secondary and only needs to be adjacent, not identical. Remove only clear genre violations. Return a JSON array of {artist, title} objects you KEEP.`;

    try {
      const kept = await generateTracksWithGemini(userPrompt, null, false, 0.3, sysInstruction);
      if (Array.isArray(kept) && kept.length > 0) {
        const keptIds = new Set();
        kept.forEach(s => {
          const sA = (s.artist || '').toLowerCase();
          const sT = (s.title  || '').toLowerCase();
          const match = candidates.find(t => {
            const tA = t.artist.toLowerCase();
            const tT = t.title.toLowerCase();
            const titleMatch  = tT.includes(sT) || sT.includes(tT);
            const artistMatch = tA.includes(sA) || sA.includes(tA);
            return titleMatch && artistMatch;
          });
          if (match) keptIds.add(match.trackId);
        });
        accepted = candidates.filter(c => keptIds.has(c.trackId));
        console.log(`🛡️ [Smart-Fill] Gatekeeper kept ${accepted.length}/${candidates.length}`);
      } else {
        console.warn('⚠️ [Smart-Fill] Gatekeeper returned empty — accepting radio output raw');
      }
    } catch (err) {
      console.warn('⚠️ [Smart-Fill] Gatekeeper failed — accepting radio output raw:', err.message);
    }
  }

  if (!accepted.length) {
    console.log('🕒 [Smart-Fill] Nothing survived Gatekeeper');
    return;
  }

  for (const t of accepted) {
    poolSources.smart.push(t);
    if (poolSources.smart.length > 150) poolSources.smart.shift();
  }
  mergePool();
  broadcast();
  console.log(`✨ [Smart-Fill] Added ${accepted.length} tracks (bucket: ${poolSources.smart.length}/150)`);
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
  if (!LASTFM_API_KEY || !YOUTUBE_API_KEY || (activeGenreIds.size === 0 && activeMoodIds.size === 0)) { 
    poolSources.moods = []; 
    return; 
  }
  // Check if we already have a combined pool for current selection
  const comboKey = [...activeGenreIds, ...activeMoodIds].sort().join('+');
  if (moodPoolCache.has(comboKey) && moodPoolCache.get(comboKey).length >= 10) return;

  console.log(`🎭 AI-DJ: Ensuring pool is ready for selection: ${comboKey}...`);
  refillMoodPoolUltra();
}

async function refillMoodPoolUltra(clearExisting = false) {
  const genres = Array.from(activeGenreIds).map(id => AVAILABLE_GENRES.find(g => g.id === id)).filter(Boolean);
  const moods  = Array.from(activeMoodIds).map(id => AVAILABLE_MOODS.find(m => m.id === id)).filter(Boolean);
  
  if (genres.length === 0 && moods.length === 0) return;

  const comboKey = [...activeGenreIds, ...activeMoodIds].sort().join('+');
  if (refillingMoodIds.has(comboKey)) return;
  refillingMoodIds.add(comboKey);

  const genreNames = genres.map(g => g.name).join(' + ');
  const moodNames  = moods.map(m => m.name).join(' + ');
  const displayName = `${genreNames}${moodNames ? ' (' + moodNames + ')' : ''}`;

  if (clearExisting) {
    console.log(`🧹 [Ultra-Fill] Fresh start for: ${displayName}`);
    moodPoolCache.delete(comboKey);
  }

  try {
    console.log(`🚀 [Ultra-Fill] Starting high-power discovery for: ${displayName}`);

    const genreDescs = genres.map(g => g.description).filter(Boolean).join('\n');
    const seedPrompt = `You are a legendary bar DJ. I need the 5 absolute BEST, most iconic tracks for this specific vibe.
    
    CORE GENRES: ${genreNames || 'Any bar-friendly genre'}
    ATMOSPHERE/MOODS: ${moodNames || 'General bar vibe'}
    
    ${genreDescs}
    
    CRITICAL RULE: Every single track MUST be a perfect blend that hits ALL selected genres and moods simultaneously. I want the specific intersection where these worlds meet.
    
    MUSICAL SANITY CHECK: If the combination is contradictory (e.g. "Metal" + "Chill"), prioritize the most logical "Anchor" and ignore outliers. 
    
    Return ONLY a JSON array of 5 objects: [{"artist": "...", "title": "..."}].`;

    // Phase 1: Brain
    // Give 2.5 Flash two shots, then move to 3 Flash instead of lingering on 2.5.
    // Final two attempts alternate once more rather than ending on another 2.5 pair.
    let seeds = [];
    const seedModels = [
      'gemini-2.5-flash', 'gemini-2.5-flash',
      'gemini-3-flash-preview', 'gemini-3-flash-preview',
      'gemini-2.5-flash', 'gemini-3-flash-preview'
    ];

    for (let attempt = 0; attempt < seedModels.length; attempt++) {
      const model = seedModels[attempt];
      console.log(`🧠 [Ultra-Fill] Seeding attempt ${attempt + 1}/6 with model: ${model}`);
      
      try {
        seeds = await generateTracksWithGemini(seedPrompt, null, true, 0.8, null, model, true);
        if (seeds && seeds.length > 0) break; // Success!
      } catch (e) {
        console.warn(`  ⚠️ Attempt ${attempt + 1} failed: ${e.message}`);
      }
      // Small pause between manual retries
      if (attempt < seedModels.length - 1) await new Promise(r => setTimeout(r, 2000));
    }

    if (!seeds || !seeds.length) throw new Error('Gemini failed seeds after 6 systematic attempts');

    console.log(`✨ S-Tier seeds picked. Expanding via Radio...`);
    discoveryProgress = { active: true, current: 0, target: 100, moodName: displayName };
    broadcast();

    const candidatePool = [];
    const seenIds = new Set();
    const existing = moodPoolCache.get(comboKey) || [];
    existing.forEach(t => seenIds.add(t.trackId));
    let chartTracks = [];

    if (freshnessEnabled) {
      const chartData = await fetchChartTracksForLab(80);
      chartTracks = chartData.chartTracks;
      console.log(`📈 [Ultra-Fill] Latest Hits mode ON — chart-boosting radio candidates with ${chartTracks.length} chart tracks`);
    }

    // Phase 2 & 3: Expansion
    for (const seed of seeds) {
      try {
        const winner = await findBestYouTubeMatch(seed);
        if (!winner?.id) continue;
        console.log(`  📻 Radio: "${seed.artist} - ${seed.title}"`);
        const { data: radioTracks } = await axios.get(`${YTMUSIC_SERVICE_URL}/radio`, { params: { videoId: winner.id, limit: 30 }, timeout: 10000 });
        if (Array.isArray(radioTracks)) {
          const expansionTracks = freshnessEnabled
            ? buildChartBoostedCandidates(radioTracks[0] || seed, radioTracks, chartTracks, 30)
            : radioTracks.slice(1);

          for (const rt of expansionTracks) {
            if (rt.videoId && !seenIds.has(rt.videoId)) {
              const track = mapYtmSongToTrack(rt);
              if (isValidSongDuration(track.duration) && isPoolEligible(track)) {
                seenIds.add(rt.videoId);
                candidatePool.push({ ...track, source: 'moods', aiGenerated: true });
              }
            }
          }
        }
      } catch (e) { console.warn(`  ⚠️ Seed failed:`, e.message); }
      await new Promise(r => setTimeout(r, 200));
    }

    if (candidatePool.length > 0) {
      console.log(`🛡️ [Ultra-Fill] Gatekeeper judging ${candidatePool.length} tracks in chunks...`);
      const CHUNK_SIZE = 40;
      const sysInstruction = `You are an "Impostor Filter" for a bar DJ. Your job is ONLY to remove songs that are "a nail in the eye"—obvious mismatches that don't belong in the set at all. If it fits the energy/genre reasonably well, KEEP IT. Return JSON array of objects you KEEP.`;
      const chunks = [];
      for (let i = 0; i < candidatePool.length; i += CHUNK_SIZE) {
        chunks.push(candidatePool.slice(i, i + CHUNK_SIZE));
      }
      const allAcceptedIds = await runPinnedGatekeeperChunks(chunks, displayName, sysInstruction);

      const finalPool = candidatePool.filter(t => allAcceptedIds.has(t.trackId));
      const rejectedPool = candidatePool.filter(t => !allAcceptedIds.has(t.trackId));
      console.log(`✅ Accepted ${finalPool.length}/${candidatePool.length} tracks.`);
      
      const updatedList = [...existing, ...finalPool];
      moodPoolCache.set(comboKey, updatedList);
      
      discoveryProgress.current = finalPool.length;
      discoveryProgress.target = finalPool.length;
      mergePool();
      broadcast();
      
      try {
        fs.writeFileSync('last_refill.txt', finalPool.map(t => `${t.artist} - ${t.title}`).join('\n'));
        fs.writeFileSync('rejected_songs.txt', rejectedPool.map(t => `${t.artist} - ${t.title}`).join('\n'));
      } catch (e) {}
    }
  } catch (err) { console.error(`❌ Ultra-Fill failed:`, err.message); }
  finally { refillingMoodIds.delete(comboKey); discoveryProgress.active = false; broadcast(); }
}

async function refillMoodPool(moodId) {
  // Use the combined Ultra-Fill engine
  return refillMoodPoolUltra();
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
    geminiApiKey: getNonPaidGeminiKey(),
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
        
        // Find the "Gold" ATV version, but never replace a valid request with a Short/preview.
        const atv = (songs || []).find(s => {
          const durationMs = parseDurationToMs(s.duration);
          return s.videoType === 'MUSIC_VIDEO_TYPE_ATV' &&
            s.videoId &&
            isValidSongDuration(durationMs) &&
            !isLikelyShortsTrack({ title: s.title, album: s.album });
        });
        if (atv) {
          console.log(`🎵 [ATV RESOLVE] Studio Audio found: "${item.title}" → ${atv.videoId}`);
          item.trackId = atv.videoId;
          item.duration = parseDurationToMs(atv.duration) || item.duration;
          item.videoType = atv.videoType || item.videoType;
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
        const details = await ytVideoDetails(videos.slice(0, 8).map(v => v.id));
        const detailMap = new Map(details.map(d => [d.id, d]));
        const best = videos
          .map(v => detailMap.get(v.id))
          .filter(Boolean)
          .map(mapVideoItemToTrack)
          .filter(isQueueEligibleTrack)
          .sort((a, b) => scoreYtItem({ snippet: { title: a.title, channelTitle: a.artist } }) - scoreYtItem({ snippet: { title: b.title, channelTitle: b.artist } }))
          .reverse()[0];
        if (best && best.trackId !== item.trackId) {
          console.log(`🎵 [ATV RESOLVE] Scraper found high-quality fallback: "${item.title}" → ${best.trackId}`);
          item.trackId = best.trackId;
          item.duration = best.duration || item.duration;
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
    const safeCached = cached.filter(isQueueEligibleTrack);
    if (safeCached.length !== cached.length) searchCacheSet(normalizedQ, safeCached);
    return res.json(safeCached);
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
        let candidates = (songs || []).filter(s => {
          if (!s.videoId) return false;
          const durationMs = parseDurationToMs(s.duration);
          return isValidSongDuration(durationMs) && !isLikelyShortsTrack({ title: s.title, album: s.album });
        });
        
        if (candidates.length) {
          tracks = candidates.map(mapYtmSongToTrack).filter(isQueueEligibleTrack);
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
            tracks = details.map(mapVideoItemToTrack).filter(isQueueEligibleTrack);
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
        tracks = details.map(mapVideoItemToTrack).filter(isQueueEligibleTrack);
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
      saved:  { total: poolSources.saved.length },
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

app.delete('/api/pool/saved', requireAdmin, (req, res) => {
  const removed = poolSources.saved.length;
  poolSources.saved = [];
  mergePool();
  broadcast();
  console.log(`🧹 Cleared ${removed} loaded saved-playlist track(s) from active pool`);
  res.json({ success: true, removed, totalInPool: playlistCache.bar.length });
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
  res.json({
    genres: AVAILABLE_GENRES.map(g => ({ ...g, active: activeGenreIds.has(g.id) })),
    moods: AVAILABLE_MOODS.map(m => ({ ...m, active: activeMoodIds.has(m.id) }))
  });
});

app.post('/api/pool/moods/rebuild/custom', requireAdmin, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  // 1. Clear existing mood state to make room for custom vibe
  activeGenreIds.clear();
  activeMoodIds.clear();
  moodPoolCache.clear();

  // Create/Update virtual mood object
  const customMoodId = 'custom_vibe';
  const virtualMood = { id: customMoodId, name: 'Custom Vibe', description: prompt };
  const existingIndex = AVAILABLE_GENRES.findIndex(m => m.id === customMoodId);
  if (existingIndex >= 0) AVAILABLE_GENRES[existingIndex] = virtualMood;
  else AVAILABLE_GENRES.push(virtualMood);

  activeGenreIds.add(customMoodId);

  console.log(`✨ AI-DJ: Building Ultra-Fill pool from CUSTOM PROMPT: "${prompt}"`);
  res.json({ success: true, message: 'Custom build started' });

  // Trigger the expansion with clearExisting = true
  refillMoodPoolUltra(true);
});

app.put('/api/pool/genres/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const genre = AVAILABLE_GENRES.find(g => g.id === id);
  if (!genre) return res.status(404).json({ error: 'Unknown genre' });
  const { active } = req.body;
  if (active) activeGenreIds.add(id);
  else activeGenreIds.delete(id);
  mergePool();
  saveMetadataCache();
  res.json({ success: true, genreId: id, active });
});

app.put('/api/pool/moods/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const mood = AVAILABLE_MOODS.find(m => m.id === id);
  if (!mood) return res.status(404).json({ error: 'Unknown mood' });
  const { active } = req.body;
  if (active) activeMoodIds.add(id);
  else activeMoodIds.delete(id);
  mergePool();
  saveMetadataCache();
  res.json({ success: true, moodId: id, active });
});

app.post('/api/pool/moods/populate', requireAdmin, async (req, res) => {
  if (activeGenreIds.size === 0 && activeMoodIds.size === 0) {
    return res.status(400).json({ error: 'No genres or moods selected' });
  }

  const { freshness } = req.body; 
  freshnessEnabled = !!freshness; 

  const genreNames = Array.from(activeGenreIds).map(id => AVAILABLE_GENRES.find(g => g.id === id)?.name).join(' + ');
  const moodNames  = Array.from(activeMoodIds).map(id => AVAILABLE_MOODS.find(m => m.id === id)?.name).join(' + ');
  const comboName = `${genreNames}${moodNames ? ' (' + moodNames + ')' : ''}`;

  console.log(`✨ AI-DJ: Manually populating Ultra-Fill pool for: ${comboName}...`);
  res.json({ success: true, message: `Starting build for ${comboName}` });

  // Trigger the master combined Ultra-Fill
  refillMoodPoolUltra(true);
});

app.post('/api/pool/radio-seed', requireAdmin, async (req, res) => {
  const { track } = req.body;
  if (!track?.trackId || !track?.title) {
    return res.status(400).json({ error: 'track with trackId and title required' });
  }
  if (!ytmusicReady) return res.status(503).json({ error: 'YouTube Music not ready' });

  try {
    console.log(`📻 [Admin Radio Seed] Building raw radio pool from: "${track.artist || 'Unknown'} - ${track.title}"`);

    const { data: radioTracks } = await axios.get(`${YTMUSIC_SERVICE_URL}/radio`, {
      params: { videoId: track.trackId, limit: 30 },
      timeout: 15000,
    });

    if (!Array.isArray(radioTracks) || !radioTracks.length) {
      return res.status(404).json({ error: 'No radio tracks returned for that seed' });
    }

    const existingIds = new Set([
      ...playlistCache.bar.map(t => t.trackId),
      ...poolSources.smart.map(t => t.trackId),
    ].filter(Boolean));

    let added = 0;
    const candidates = [
      {
        videoId: track.trackId,
        title: track.title,
        artist: track.artist,
        album: track.album || '',
        albumArt: track.albumArt || null,
        duration: typeof track.duration === 'number' ? Math.round(track.duration / 1000) : track.duration,
        videoType: track.videoType || '',
      },
      ...radioTracks.slice(1),
    ];

    for (const item of candidates) {
      if (!item?.videoId || existingIds.has(item.videoId)) continue;
      const mapped = mapYtmSongToTrack(item);
      if (!isValidSongDuration(mapped.duration) || !isPoolEligible(mapped)) continue;
      existingIds.add(item.videoId);
      poolSources.smart.push({ ...mapped, source: 'smart' });
      if (poolSources.smart.length > 150) poolSources.smart.shift();
      added++;
    }

    mergePool();
    broadcast();

    res.json({
      success: true,
      added,
      seed: { trackId: track.trackId, title: track.title, artist: track.artist || 'Unknown' },
      totalInPool: playlistCache.bar.length,
    });
  } catch (err) {
    console.error('[Admin Radio Seed] Error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error || 'Radio build failed' });
  }
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
  const { trackId, title, artist, album, albumArt, explicit, videoType } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });
  if (BLOCK_EXPLICIT && explicit) return res.status(400).json({ error: 'Explicit songs are disabled' });
  const duration = parseDurationToMs(req.body.duration);
  if (!isValidSongDuration(duration)) {
    return res.status(400).json({ error: 'That result looks like a Short/clip, not a full song. Please choose another version.' });
  }
  if (isLikelyShortsTrack({ title, album })) {
    return res.status(400).json({ error: 'Shorts/clips/previews cannot be added to the queue.' });
  }
  if (queue.find(i => i.trackId === trackId)) return res.status(409).json({ error: 'Song already in queue' });
  if (currentTrack?.trackId === trackId) return res.status(409).json({ error: 'Song is currently playing' });

  const item = {
    id: uuidv4(), trackId, title, artist, album, albumArt, explicit, duration, videoType,
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

// ─── Pro DJ Lab: Audio Streaming (yt-dlp) ─────────────────────────────────────
// Streams the bestaudio track for a given YouTube video ID straight through the
// response so the browser can feed it to AudioContext.decodeAudioData().
// Prefers m4a (AAC) since every modern browser's Web Audio decoder handles it.
app.get('/api/pro-audio/:vid', (req, res) => {
  const vid = (req.params.vid || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
    return res.status(400).json({ error: 'Invalid video id' });
  }
  const url = `https://www.youtube.com/watch?v=${vid}`;
  const args = [
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '-o', '-',
    url
  ];
  const child = spawn('yt-dlp', args);
  let headered = false;

  child.stdout.on('data', (chunk) => {
    if (!headered) {
      headered = true;
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Cache-Control', 'no-store');
    }
    res.write(chunk);
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  child.on('error', (err) => {
    console.error(`pro-audio spawn error (${vid}):`, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'yt-dlp spawn failed', detail: err.message });
    else res.end();
  });

  child.on('close', (code) => {
    if (code !== 0 && !headered) {
      console.error(`pro-audio yt-dlp failed (${vid}, code ${code}): ${stderrBuf.slice(0, 500)}`);
      if (!res.headersSent) return res.status(502).json({ error: 'yt-dlp failed', code, detail: stderrBuf.slice(0, 500) });
    }
    res.end();
  });

  req.on('close', () => { try { child.kill('SIGKILL'); } catch (_) {} });
});

// ─── Pro DJ Lab: Deep Shadow Native Analysis (cached) ─────────────────────────
// Runs the local native Essentia probe once per videoId, then reuses the JSON.
// Browser Shadow Engine remains the immediate/live fallback in Pro DJ Lab.
function getDeepShadowPython() {
  return process.env.DEEP_SHADOW_PYTHON || path.join(__dirname, '.venv-deep-shadow', 'bin', 'python');
}

function runDeepShadowProbe(videoId) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(getDeepShadowPython(), [
      path.join(__dirname, 'deep_shadow_probe.py'),
      '--video-id', videoId,
      '--voice',
      '--extras',
      '--tonal',
      '--compact'
    ], { cwd: __dirname });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`deep_shadow_probe exited ${code}: ${stderr.slice(0, 700)}`));
      }
      try {
        const jsonStart = stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        const jsonText = jsonStart >= 0 && jsonEnd > jsonStart
          ? stdout.slice(jsonStart, jsonEnd + 1)
          : stdout;
        const parsed = JSON.parse(jsonText);
        if (parsed?.error) return reject(new Error(parsed.error));
        resolve({
          ...parsed,
          videoId,
          analyzedAt: new Date().toISOString(),
          serverTimingSec: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
          source: 'deep_shadow_probe'
        });
      } catch (err) {
        reject(new Error(`Deep Shadow JSON parse failed: ${err.message}; stderr=${stderr.slice(0, 300)}`));
      }
    });
  });
}

async function getDeepShadowAnalysis(videoId, refresh = false) {
  const cached = deepShadowCache.get(videoId);
  if (!refresh && cached?.sections && Array.isArray(cached.beatPeaks)) {
    return { analysis: cached, cached: true };
  }
  if (deepShadowInFlight.has(videoId)) {
    return { analysis: await deepShadowInFlight.get(videoId), cached: false, joined: true };
  }

  const promise = runDeepShadowProbe(videoId)
    .then(analysis => {
      deepShadowCache.set(videoId, analysis);
      saveDeepShadowCache();
      return analysis;
    })
    .finally(() => deepShadowInFlight.delete(videoId));

  deepShadowInFlight.set(videoId, promise);
  return { analysis: await promise, cached: false };
}

app.get('/api/deep-shadow/:videoId', requireAdmin, async (req, res) => {
  const vid = (req.params.videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).json({ error: 'Invalid video id' });

  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await getDeepShadowAnalysis(vid, refresh);
    res.json(result);
  } catch (err) {
    console.error(`Deep Shadow failed (${vid}):`, err.message);
    res.status(502).json({ error: 'Deep Shadow analysis failed', detail: err.message });
  }
});

// ─── Pro DJ Lab: Deep AI Audit (label-only, v4) ───────────────────────────────
// REQUIRES client to POST sections:[{start,end}] computed by Shadow Engine.
// Gemini's ONLY job is to attach a label/energy/note to each pre-computed
// section. It NEVER returns timestamps. Server echoes client start/end so
// boundaries can never drift.
const AUDIT_MODELS = [
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

app.post('/api/audit-audio/:videoId', requireAdmin, async (req, res) => {
  const vid = (req.params.videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return res.status(400).json({ error: 'Invalid video id' });
  const sections = Array.isArray(req.body?.sections) ? req.body.sections : null;
  if (!sections || sections.length === 0) {
    return res.status(400).json({ error: 'sections[{start,end}] required in body' });
  }
  const key = getNonPaidGeminiKey();
  if (!key) return res.status(500).json({ error: 'GEMINI_VOICE_KEY missing' });

  // 1. Download audio to a temp file via yt-dlp.
  const tmpDir = path.join(__dirname, 'node_modules', '.cache');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
  const tmpPath = path.join(tmpDir, `audit_${vid}_${Date.now()}.m4a`);

  function runYtDlp() {
    return new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', [
        '-f', 'bestaudio[ext=m4a]/bestaudio',
        '--no-playlist', '--no-warnings', '--quiet',
        '-o', tmpPath,
        `https://www.youtube.com/watch?v=${vid}`
      ]);
      let err = '';
      child.stderr.on('data', d => err += d.toString());
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp ${code}: ${err.slice(0, 300)}`)));
    });
  }

  try {
    await runYtDlp();
    const audioBytes = fs.readFileSync(tmpPath);
    const mimeType = 'audio/mpeg'; // Gemini File API accepts audio/mpeg for m4a/mp4 audio

    // 2. Upload to Gemini File API (single-shot start+upload+finalize).
    let fileUri = null, storedMime = mimeType;
    try {
      const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`;
      const upResp = await axios.post(uploadUrl, audioBytes, {
        headers: {
          'Content-Type': mimeType,
          'X-Goog-Upload-Protocol': 'raw',
          'X-Goog-Upload-File-Name': `audit_${vid}.m4a`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000
      });
      fileUri = upResp.data?.file?.uri || null;
      storedMime = upResp.data?.file?.mimeType || mimeType;
    } catch (e) {
      console.warn(`audit: File API upload failed (${vid}):`, e.response?.data || e.message);
    }

    // 3. Build the prompt. Gemini sees the FIXED section table and returns
    // exactly N {i, label, energy, note} entries — NO timestamps.
    const sectionTable = sections.map((s, i) =>
      `${i}. ${Number(s.start).toFixed(2)}s → ${Number(s.end).toFixed(2)}s`
    ).join('\n');

    const prompt = `You are an expert music structure analyst. You have been given an audio track and a FIXED table of ${sections.length} section boundaries computed by a DSP engine (Essentia). Your ONLY job is to attach a semantic label, an energy rating (0.0–1.0), and a one-line note to EACH section — in order. You MUST NOT return timestamps. You MUST NOT add or remove sections. Return EXACTLY ${sections.length} entries.

Allowed labels (pick the single best fit): Intro, Verse, Pre-Chorus, Chorus, Drop, Post-Chorus, Bridge, Breakdown, Instrumental, Build-Up, Outro, Ending, Fade.

Rules:
- "Verse" requires vocals. A section with no vocals is Instrumental, Bridge, or Breakdown.
- "Drop" = the highest-impact full-band moment after a build-up (EDM/pop) OR the first hard chorus in a rock/hip-hop track.
- "Outro" / "Ending" / "Fade" only apply to the final section(s) of the track.
- Be decisive — do not return "Unknown" or empty labels.

Fixed section table (index, start, end):
${sectionTable}

Return ONLY a JSON object of this shape:
{"sections":[{"i":0,"label":"Intro","energy":0.25,"note":"sparse piano"}, ...]}`;

    const payloadBase = {
      contents: [{ parts: [] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    };

    async function callModel(model, useInline) {
      const parts = [];
      if (useInline) {
        parts.push({ inlineData: { mimeType, data: audioBytes.toString('base64') } });
      } else if (fileUri) {
        parts.push({ fileData: { mimeType: storedMime, fileUri } });
      } else {
        throw new Error('No audio envelope available');
      }
      parts.push({ text: prompt });
      const body = { ...payloadBase, contents: [{ parts }] };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const { data } = await axios.post(url, body, {
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000
      });
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      return JSON.parse(cleaned);
    }

    // 4. Model cascade — try each with fileData first, then inlineData.
    let parsed = null, usedModel = null, usedEnvelope = null, lastErr = null;
    for (const model of AUDIT_MODELS) {
      for (const useInline of fileUri ? [false, true] : [true]) {
        try {
          parsed = await callModel(model, useInline);
          usedModel = model;
          usedEnvelope = useInline ? 'inlineData' : 'fileData';
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`audit ${model} (${useInline ? 'inlineData' : 'fileData'}) failed:`, e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
        }
      }
      if (parsed) break;
    }
    if (!parsed) throw lastErr || new Error('All Gemini models failed');

    // 5. Merge Gemini labels back onto the FIXED client boundaries.
    const labels = Array.isArray(parsed.sections) ? parsed.sections : [];
    const merged = sections.map((s, i) => {
      const g = labels.find(x => Number(x?.i) === i) || labels[i] || {};
      return {
        start: Number(s.start),
        end: Number(s.end),
        label: g.label || 'Unknown',
        energy: typeof g.energy === 'number' ? g.energy : null,
        note: g.note || ''
      };
    });

    console.log(`✅ audit ${vid}: ${merged.length} sections via ${usedModel} (${usedEnvelope})`);
    res.json({ success: true, structure: { sections: merged }, model: usedModel, envelope: usedEnvelope });
  } catch (err) {
    console.error(`audit ${vid} failed:`, err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message, detail: err.response?.data });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
});

// ─── Saved Playlists (named pool presets) ─────────────────────────────────────
// Storage: saved_playlists.json on disk. Each entry captures the tracks + the
// mood/genre combo that originated it, so the user can "refresh with original
// moods" later without retyping the combo.

// GET — list all playlists (metadata only, no full track arrays to keep payload small)
app.get('/api/playlists', requireAdmin, (req, res) => {
  res.json(savedPlaylists.map(p => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    moods: p.moods || { genres: [], moods: [] },
    trackCount: (p.tracks || []).length,
  })));
});

// GET — full playlist with all tracks (for edit view)
app.get('/api/playlists/:id', requireAdmin, (req, res) => {
  const p = findSavedPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  res.json(p);
});

// POST — create playlist from current pool (snapshot)
// Body: { name, source?: 'currentPool' | 'tracks', tracks?: [...] }
app.post('/api/playlists', requireAdmin, (req, res) => {
  const { name, source, tracks: bodyTracks } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (savedPlaylists.find(p => p.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(409).json({ error: 'A playlist with that name already exists' });
  }

  let snapshot;
  if (source === 'tracks' && Array.isArray(bodyTracks)) {
    snapshot = bodyTracks;
  } else {
    snapshot = playlistCache.bar.slice(); // current pool
  }
  if (snapshot.length === 0) return res.status(400).json({ error: 'Current pool is empty — nothing to save' });

  const playlist = {
    id: uuidv4(),
    name: name.trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    moods: {
      genres: Array.from(activeGenreIds),
      moods:  Array.from(activeMoodIds),
    },
    tracks: snapshot.map(t => ({
      trackId: t.trackId,
      title: t.title,
      artist: t.artist,
      album: t.album || '',
      albumArt: t.albumArt || null,
      duration: t.duration || null,
      explicit: !!t.explicit,
    })),
  };
  savedPlaylists.push(playlist);
  persistSavedPlaylists();
  console.log(`💾 Saved playlist "${playlist.name}" (${playlist.tracks.length} tracks)`);
  res.json({ success: true, playlist: { id: playlist.id, name: playlist.name, trackCount: playlist.tracks.length } });
});

// PATCH — rename playlist
app.patch('/api/playlists/:id', requireAdmin, (req, res) => {
  const p = findSavedPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (savedPlaylists.find(x => x.id !== p.id && x.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(409).json({ error: 'Another playlist already uses that name' });
  }
  p.name = name.trim();
  p.updatedAt = Date.now();
  persistSavedPlaylists();
  res.json({ success: true, id: p.id, name: p.name });
});

// DELETE — remove playlist
app.delete('/api/playlists/:id', requireAdmin, (req, res) => {
  const idx = savedPlaylists.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist not found' });
  const [removed] = savedPlaylists.splice(idx, 1);
  // If this playlist's tracks are currently loaded into the pool, clear them too.
  poolSources.saved = poolSources.saved.filter(t => !(removed.tracks || []).some(st => st.trackId === t.trackId));
  persistSavedPlaylists();
  mergePool();
  broadcast();
  console.log(`🗑️  Deleted saved playlist "${removed.name}"`);
  res.json({ success: true });
});

// POST /load — push the playlist's tracks into poolSources.saved
// Body: { mode: 'replace' | 'merge' }
//   replace → wipe ALL discovery sources + load ONLY saved tracks
//   merge   → append saved tracks to whatever's in the pool already
app.post('/api/playlists/:id/load', requireAdmin, (req, res) => {
  const p = findSavedPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  const { mode } = req.body || {};
  if (!['replace', 'merge'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'replace' or 'merge'" });
  }

  const savedTracks = (p.tracks || []).map(t => ({ ...t }));

  if (mode === 'replace') {
    // Wipe auto-discovery sources so only the saved preset remains
    poolSources.moods  = [];
    poolSources.artist = [];
    poolSources.smart  = [];
    poolSources.charts = [];
    moodPoolCache.clear();
    activeGenreIds.clear();
    activeMoodIds.clear();
    poolSources.saved = savedTracks;
  } else {
    // merge — dedupe by trackId against whatever is already in saved
    const existingIds = new Set(poolSources.saved.map(t => t.trackId));
    for (const t of savedTracks) {
      if (!existingIds.has(t.trackId)) {
        poolSources.saved.push(t);
        existingIds.add(t.trackId);
      }
    }
  }

  mergePool();
  broadcast();
  console.log(`📂 Loaded playlist "${p.name}" (${mode}) — pool now ${playlistCache.bar.length} tracks`);
  res.json({ success: true, mode, loaded: savedTracks.length, totalInPool: playlistCache.bar.length });
});

// DELETE /tracks/:trackId — remove a track from the playlist
app.delete('/api/playlists/:id/tracks/:trackId', requireAdmin, (req, res) => {
  const p = findSavedPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  const before = (p.tracks || []).length;
  p.tracks = (p.tracks || []).filter(t => t.trackId !== req.params.trackId);
  if (p.tracks.length === before) return res.status(404).json({ error: 'Track not found in playlist' });
  p.updatedAt = Date.now();
  persistSavedPlaylists();
  // Reflect in the live pool if this playlist is currently loaded
  poolSources.saved = poolSources.saved.filter(t => t.trackId !== req.params.trackId);
  mergePool();
  broadcast();
  res.json({ success: true, trackCount: p.tracks.length });
});

// POST /tracks — add tracks to the playlist
// Body: { tracks: [{trackId, title, artist, ...}] }  OR  { trackIds: [...] } to pull from current pool
app.post('/api/playlists/:id/tracks', requireAdmin, (req, res) => {
  const p = findSavedPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  let incoming = [];
  if (Array.isArray(req.body?.tracks)) {
    incoming = req.body.tracks;
  } else if (Array.isArray(req.body?.trackIds)) {
    const set = new Set(req.body.trackIds);
    incoming = playlistCache.bar.filter(t => set.has(t.trackId));
  } else {
    return res.status(400).json({ error: 'tracks[] or trackIds[] required' });
  }
  const existing = new Set((p.tracks || []).map(t => t.trackId));
  let added = 0;
  for (const t of incoming) {
    if (!t?.trackId || existing.has(t.trackId)) continue;
    p.tracks.push({
      trackId: t.trackId,
      title: t.title,
      artist: t.artist,
      album: t.album || '',
      albumArt: t.albumArt || null,
      duration: t.duration || null,
      explicit: !!t.explicit,
    });
    existing.add(t.trackId);
    added++;
  }
  p.updatedAt = Date.now();
  persistSavedPlaylists();
  res.json({ success: true, added, trackCount: p.tracks.length });
});

// POST /refresh — re-activate the moods/genres this playlist was born with and
// trigger a fresh Ultra-Fill. Does NOT mutate the playlist; user hits "add
// from current pool" afterwards to incorporate the new results.
app.post('/api/playlists/:id/refresh', requireAdmin, (req, res) => {
  const p = findSavedPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: 'Playlist not found' });
  const originMoods = p.moods || { genres: [], moods: [] };
  if (originMoods.genres.length === 0 && originMoods.moods.length === 0) {
    return res.status(400).json({ error: 'Playlist was saved without a mood combo — nothing to refresh from' });
  }
  // Swap active mood state to the playlist's origin combo and trigger refill
  activeGenreIds.clear();
  activeMoodIds.clear();
  originMoods.genres.forEach(id => activeGenreIds.add(id));
  originMoods.moods .forEach(id => activeMoodIds.add(id));
  moodPoolCache.delete([...activeGenreIds, ...activeMoodIds].sort().join('+'));
  console.log(`🔄 Refresh for "${p.name}" — re-running moods: genres=${[...activeGenreIds].join(',')} moods=${[...activeMoodIds].join(',')}`);
  res.json({ success: true, message: 'Refresh triggered — watch the pool fill, then click "Add new from pool" in edit.' });
  refillMoodPoolUltra(true);
});

// ─── Pro DJ Lab: Live Scout model discovery ───────────────────────────────────
app.get('/api/live-scout/models', async (req, res) => {
  const key = getNonPaidGeminiKey();
  if (!key) return res.json({ v1beta: [], v1alpha: [] });
  async function list(version) {
    try {
      const { data } = await axios.get(
        `https://generativelanguage.googleapis.com/${version}/models?key=${key}`,
        { timeout: 10000 }
      );
      return (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).some(x => /bidiGenerateContent|generateContent/i.test(x)))
        .filter(m => /live|flash/i.test(m.name))
        .map(m => m.name);
    } catch (_) { return []; }
  }
  const [v1beta, v1alpha] = await Promise.all([list('v1beta'), list('v1alpha')]);
  res.json({ v1beta, v1alpha });
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
  loadDeepShadowCache();
  loadMoodBlacklist();
  loadSavedPlaylists();
  await startYTMusicService();
  rebuildPool().catch(err => console.warn('Startup pool build failed:', err.message));

  // Every 25 minutes, expand the Smart-Fill bucket via YT Music Radio seeded from the current track.
  // Respects the smartFillEnabled toggle (early-return inside fetchSmartDiscovery).
  setInterval(() => {
    if (!smartFillEnabled) return;
    console.log('🕒 Scheduled Smart-Fill tick...');
    fetchSmartDiscovery().catch(err => console.warn('Smart-Fill tick failed:', err.message));
  }, 25 * 60 * 1000);
});

// Graceful shutdown — kill the Python child process so it doesn't linger
process.on('SIGINT',  () => { ytmusicProcess?.kill(); process.exit(0); });
process.on('SIGTERM', () => { ytmusicProcess?.kill(); process.exit(0); });
