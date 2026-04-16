#!/usr/bin/env python3
"""
YouTube Music microservice — wraps sigma67/ytmusicapi.
Exposes videoType on every track so server.js can reliably
distinguish MUSIC_VIDEO_TYPE_ATV (pure audio) from music videos.

Usage: python3 ytmusic_service.py [port]   (default 5001)
"""

import sys
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
from ytmusicapi import YTMusic

app = Flask(__name__)
CORS(app) # Enable CORS for all routes
ytmusic = YTMusic()  # unauthenticated — read-only search/browse is fine


# ── Helpers ───────────────────────────────────────────────────────────────────

def best_thumbnail(thumbnails):
    if not thumbnails:
        return None
    return sorted(thumbnails, key=lambda t: t.get('width', 0), reverse=True)[0].get('url')


def format_song(item):
    """Normalize a ytmusicapi song/track dict to our wire format."""
    artists = item.get('artists') or []
    artist_name = artists[0].get('name', 'Unknown') if artists else 'Unknown'

    album = item.get('album') or {}
    album_name = album.get('name', '') if isinstance(album, dict) else ''

    duration_seconds = item.get('duration_seconds') or 0

    # videoType values:
    #   MUSIC_VIDEO_TYPE_ATV  — pure audio (what YouTube Music uses natively)
    #   MUSIC_VIDEO_TYPE_OMV  — official music video
    #   MUSIC_VIDEO_TYPE_UGC  — user-generated / uploaded
    video_type = item.get('videoType') or ''

    return {
        'videoId':   item.get('videoId', ''),
        'title':     item.get('title', 'Unknown'),
        'artist':    artist_name,
        'album':     album_name,
        'albumArt':  best_thumbnail(item.get('thumbnails')),
        'duration':  duration_seconds,   # seconds — server.js converts to ms
        'videoType': video_type,
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({'ok': True})


@app.route('/search/songs')
def search_songs():
    q = request.args.get('q', '').strip()
    limit = min(int(request.args.get('limit', 20)), 50)
    filter_type = request.args.get('filter', 'songs')  # 'songs' or 'videos'
    if filter_type not in ('songs', 'videos'):
        filter_type = 'songs'
    if not q:
        return jsonify({'error': 'Query required'}), 400
    try:
        results = ytmusic.search(q, filter=filter_type, limit=limit)
        songs = [format_song(r) for r in results if r.get('videoId')]
        return jsonify(songs)
    except Exception as e:
        app.logger.error(f'search/songs error: {e}')
        return jsonify({'error': str(e)}), 500


@app.route('/search/artists')
def search_artists():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'Query required'}), 400
    try:
        results = ytmusic.search(q, filter='artists', limit=10)
        artists = []
        for r in results:
            artists.append({
                'artistId':  r.get('browseId', ''),
                'name':      r.get('artist', 'Unknown'),
                'thumbnail': best_thumbnail(r.get('thumbnails')),
            })
        return jsonify(artists)
    except Exception as e:
        app.logger.error(f'search/artists error: {e}')
        return jsonify({'error': str(e)}), 500


@app.route('/search/playlists')
def search_playlists():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'Query required'}), 400
    try:
        results = ytmusic.search(q, filter='playlists', limit=5)
        playlists = []
        for r in results:
            playlists.append({
                'playlistId': r.get('browseId', ''),
                'name':       r.get('title', 'Unknown'),
            })
        return jsonify(playlists)
    except Exception as e:
        app.logger.error(f'search/playlists error: {e}')
        return jsonify({'error': str(e)}), 500


@app.route('/playlist/tracks')
def playlist_tracks():
    playlist_id = request.args.get('id', '').strip()
    limit = min(int(request.args.get('limit', 100)), 200)
    if not playlist_id:
        return jsonify({'error': 'id required'}), 400
    try:
        playlist = ytmusic.get_playlist(playlist_id, limit=limit)
        tracks = playlist.get('tracks') or []
        return jsonify([format_song(t) for t in tracks if t.get('videoId')])
    except Exception as e:
        app.logger.error(f'playlist/tracks error: {e}')
        return jsonify({'error': str(e)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    print(f'[ytmusic] Starting on port {port}', flush=True)
    app.run(host='127.0.0.1', port=port, debug=False)
