require('dotenv').config();
const axios = require('axios');

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_API = 'https://www.googleapis.com/youtube/v3';

// ─── Helpers (Copied from server.js) ──────────────────────────────────────────

function cleanTitle(raw) {
  return raw
    .replace(/\s*[\[(]official\s*(music\s*)?(video|audio|lyric(s)?|visualizer)[\])]/gi, '')
    .replace(/\s*[\[(](lyrics?|audio|video|mv|visualizer)[\])]/gi, '')
    .trim();
}

function parseISO8601Duration(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const h = parseInt(match[1] || 0);
  const m = parseInt(match[2] || 0);
  const s = parseInt(match[3] || 0);
  return (h * 3600 + m * 60 + s) * 1000;
}

// ─── Smart Search Logic ───────────────────────────────────────────────────────

async function getLastFmMetadata(artist, track) {
  console.log(`🔍 [Last.fm] Resolving: "${artist} - ${track}"`);
  try {
    const { data } = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'track.getInfo',
        api_key: LASTFM_API_KEY,
        artist,
        track,
        format: 'json',
        autocorrect: 1
      }
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
    console.error('Last.fm error:', err.message);
    return null;
  }
}

async function searchYouTube(hardenedQuery) {
  console.log(`📺 [YouTube] Searching: ${hardenedQuery}`);
  try {
    const { data } = await axios.get(`${YT_API}/search`, {
      params: {
        part: 'snippet',
        q: hardenedQuery,
        type: 'video',
        videoCategoryId: '10',
        maxResults: 5,
        key: YOUTUBE_API_KEY
      }
    });
    return data.items || [];
  } catch (err) {
    console.error('YouTube search error:', err.message);
    return [];
  }
}

async function getVideoDetails(videoIds) {
  try {
    const { data } = await axios.get(`${YT_API}/videos`, {
      params: {
        part: 'contentDetails,snippet',
        id: videoIds.join(','),
        key: YOUTUBE_API_KEY
      }
    });
    return data.items || [];
  } catch (err) {
    return [];
  }
}

async function testSmartSearch(inputArtist, inputTrack) {
  console.log('\n--- STARTING SMART SEARCH TEST ---');
  
  // Phase 1: Contextual Hardening via Last.fm
  const meta = await getLastFmMetadata(inputArtist, inputTrack);
  if (!meta) {
    console.log('❌ Could not resolve metadata via Last.fm');
    return;
  }
  console.log(`✅ [Last.fm] Clean Metadata: "${meta.artist} - ${meta.track}" (${meta.durationMs}ms)`);
  console.log(`🏷️  Tags: ${meta.tags.slice(0, 5).join(', ')}`);

  // Phase 2: Build Hardened Query
  const hardenedQuery = `"${meta.artist}" "${meta.track}" "official audio"`;
  
  // Phase 3: YouTube Discovery
  const searchResults = await searchYouTube(hardenedQuery);
  if (!searchResults.length) {
    console.log('❌ No YouTube results found.');
    return;
  }

  // Phase 4: Validation (Enhanced Scoring)
  const details = await getVideoDetails(searchResults.map(r => r.id.videoId));
  
  console.log('\n--- VALIDATION RESULTS (v2) ---');
  details.forEach((video, index) => {
    const ytDuration = parseISO8601Duration(video.contentDetails?.duration);
    const durationDiff = Math.abs(ytDuration - meta.durationMs);
    const channel = video.snippet?.channelTitle;
    const isTopic = channel.endsWith('- Topic');
    const title = video.snippet?.title.toLowerCase();
    
    // ADJUSTMENT 1: Channel Name Bonus (Artist verification)
    const isOfficialChannel = channel.toLowerCase().includes(meta.artist.toLowerCase());

    // ADJUSTMENT 2: Tag-Based Sanity Check (Live/Remix detection)
    const isLiveOnLastFm = meta.tags.some(t => t.includes('live'));
    const isLiveOnYouTube = title.includes('live') || title.includes('concert');
    const liveMismatch = isLiveOnYouTube && !isLiveOnLastFm;

    let score = 0;
    
    // ADJUSTMENT 3: Looser Duration Window (10s)
    if (durationDiff <= 10000) score += 50; 
    if (durationDiff <= 3000)  score += 10; // Extra bonus for very tight match
    
    if (isTopic) score += 30;
    if (isOfficialChannel) score += 20;
    if (title.includes('official audio')) score += 10;
    if (title.includes('lyrics')) score += 5;
    
    // ADJUSTMENT 4: Penalties
    if (liveMismatch) score -= 60; // Heavy penalty for unwanted live versions
    if (title.includes('karaoke') || title.includes('instrumental')) score -= 100;

    console.log(`Result #${index + 1}: "${video.snippet?.title}"`);
    console.log(`   Channel: ${channel} ${isOfficialChannel ? '✅ (Artist Match)' : ''}`);
    console.log(`   Duration: ${ytDuration}ms (Diff: ${durationDiff}ms)`);
    console.log(`   Score Components: [Dur: ${durationDiff <= 10000 ? 'YES' : 'NO'}, Topic: ${isTopic}, Official: ${isOfficialChannel}, LiveMismatch: ${liveMismatch}]`);
    console.log(`   Final Confidence: ${score}/100`);
    
    if (score >= 80) {
      console.log('   ⭐ [WINNER] HIGH CONFIDENCE MATCH');
    } else if (score >= 50) {
      console.log('   ✅ [GOOD] DECENT MATCH');
    } else {
      console.log('   ⚠️ [WEAK] LOW CONFIDENCE');
    }
    console.log('');
  });
}

// Run enhanced tests
(async () => {
  await testSmartSearch('Queen', 'Bohemian Rhapsody');
  await testSmartSearch('The Weeknd', 'Blinding Lights');
  await testSmartSearch('Michael Jackson', 'Thriller');
  await testSmartSearch('Radiohead', 'Creep');
})();
