import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeTrack, MusicError } from './model.js';
import { searchYouTubeFast } from '../media/youtubeSearch.js';
const exec = promisify(execFile);
const UA = 'Lancy/1.0 (https://github.com/Anonymous20666/lancy)';
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
export function youtubeId(value) {
  let u; try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !YOUTUBE_HOSTS.has(u.hostname)) return null;
  const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|live)\/([^/]+)$/)?.[1];
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}
export class YouTubeProvider {
  constructor({ enabled = process.env.MUSIC_YTDLP_ENABLED === 'true', runner = exec } = {}) { this.id = 'youtube'; this.enabled = enabled; this.runner = runner; }
  assertEnabled() { if (!this.enabled) throw new MusicError('PROVIDER_DISABLED', 'YouTube resolution is disabled. The owner may enable MUSIC_YTDLP_ENABLED only for material they are permitted to download/stream. Try an Audius search.'); }
  async search(query, { offset = 0, limit = 5, video = false, radio = false, filterDuration = null } = {}) {
    this.assertEnabled();
    const direct = youtubeId(query);
    if (/^https?:/i.test(query) && !direct) throw new MusicError('UNSUPPORTED_URL', 'Use a supported HTTPS YouTube video URL; playlists and arbitrary URLs are not accepted.');
    const end = Math.min(offset + limit + 1, 30);
    const target = direct ? `https://www.youtube.com/watch?v=${direct}` : `ytsearch${end}:${String(query).slice(0, 180)}`;
    if (direct && offset) return { items: [], nextOffset: null };
    if (this.runner === exec && !direct) {
      try {
        const fastRaw = await searchYouTubeFast(String(query).slice(0, 180), 'NG', { wide: true, radio, filterDuration });
        const fastItems = (fastRaw || [])
          .filter(x => /^[\w-]{11}$/.test(x?.videoId || '') && !/^short$/i.test(String(x?.duration || '')) && !x?.isLive && x?.duration !== 'LIVE')
          .map(x => normalizeTrack({
            providerId: x.videoId,
            title: x.title,
            artist: x.author,
            duration: x.duration,
            artwork: x.thumb || `https://i.ytimg.com/vi/${x.videoId}/hqdefault.jpg`,
            sourceRef: `https://www.youtube.com/watch?v=${x.videoId}`,
            availability: 'unresolved',
            isLive: Boolean(x.isLive || x.duration === 'LIVE')
          }, this.id))
          .filter(t => !t.isLive && t.duration !== 'LIVE' && (!t.durationSeconds || (t.durationSeconds >= 30 && t.durationSeconds <= 7200)));
        if (fastItems.length > offset) {
          return {
            items: fastItems.slice(offset, offset + limit),
            nextOffset: fastItems.length > offset + limit && offset + limit < 30 ? offset + limit : null
          };
        }
      } catch {}
    }
    const { stdout } = await this.runner('yt-dlp', ['--ignore-config', '--no-warnings', '--skip-download', '--flat-playlist', '--dump-single-json', '--playlist-start', String(offset + 1), '--playlist-end', String(end), '--socket-timeout', '10', '--', target], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout); const entries = info.entries || [info];
    const items = entries.filter(x => /^[\w-]{11}$/.test(x?.id || '')).map(x => normalizeTrack({ providerId: x.id, title: x.track || x.title, artist: x.artist || x.uploader || x.channel, durationSeconds: x.duration, artwork: x.thumbnail || x.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${x.id}/hqdefault.jpg`, sourceRef: `https://www.youtube.com/watch?v=${x.id}`, availability: 'unresolved' }, this.id));
    return { items: items.slice(0, limit), nextOffset: !direct && items.length > limit && offset + limit < 30 ? offset + limit : null };
  }
  async download(track, path, { video = false, maxBytes = 48 * 1024 * 1024 } = {}) {
    this.assertEnabled();
    if (!/^[\w-]{11}$/.test(track.providerId)) throw new MusicError('INVALID_TRACK', 'Invalid track identifier.');
    const target = `https://www.youtube.com/watch?v=${track.providerId}`;
    const buildArgs = (fmt, { useCookies = false, useAndroidClient = false } = {}) => {
      const a = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2', '--max-filesize', String(maxBytes), '--match-filter', 'duration <= 7200 & !is_live', '--restrict-filenames', '-f', fmt, '-o', path, '--print', 'after_move:%()j'];
      if (this.runner === exec) {
        if (existsSync('/usr/bin/node')) a.push('--js-runtimes', 'node:/usr/bin/node');
        if (existsSync('/data/cache/yt-dlp')) a.push('--cache-dir', '/data/cache/yt-dlp');
        if (useCookies && existsSync('/data/youtube_cookies.txt')) a.push('--cookies', '/data/youtube_cookies.txt');
        if (useAndroidClient) a.push('--extractor-args', 'youtube:player_client=android,web');
      }
      if (video) a.push('--merge-output-format', 'mp4');
      a.push('--', target);
      return a;
    };
    const primaryFmt = video ? (this.runner === exec ? 'b[ext=mp4][vcodec^=avc1][height<=360]/bv*[vcodec^=avc1][height<=360]+ba[acodec^=mp4a]/bv*[height<=360]+ba/b[height<=360]' : 'bv*[height<=360]+ba/b[height<=360]') : 'bestaudio/best';
    let stdout;
    if (this.runner !== exec) {
      ({ stdout } = await this.runner('yt-dlp', buildArgs(primaryFmt), { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }));
    } else {
      const hasCookies = existsSync('/data/youtube_cookies.txt');
      try {
        ({ stdout } = await this.runner('yt-dlp', buildArgs(primaryFmt, { useCookies: hasCookies }), { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
      } catch (firstErr) {
        const fallbackFmt = video ? 'b[height<=480]/bv*[height<=480]+ba/bestaudio/best' : 'bestaudio/best';
        ({ stdout } = await this.runner('yt-dlp', buildArgs(fallbackFmt, { useCookies: !hasCookies, useAndroidClient: true }), { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }).catch(() => { throw firstErr; }));
      }
    }
    const lastLine = String(stdout || '').trim().split('\n').filter(Boolean).at(-1);
    if (!lastLine) throw new MusicError('DOWNLOAD_FAILED', 'The provider could not deliver a playable file within the size limit.');
    const info = JSON.parse(lastLine);
    if (info.id !== track.providerId) throw new MusicError('TRACK_MISMATCH', 'The media provider returned a different recording.');
    return normalizeTrack({ ...track, title: info.track || info.title || track.title, artist: info.artist || info.uploader || track.artist, album: info.album, durationSeconds: info.duration, artwork: info.thumbnail || info.thumbnails?.at(-1)?.url || track.artwork || `https://i.ytimg.com/vi/${track.providerId}/hqdefault.jpg`, availability: 'resolved', capabilities: { stream: true, download: true, seek: true, video } }, this.id);
  }
}
export class AudiusProvider {
  constructor({ fetcher = fetch } = {}) { this.id = 'audius'; this.fetcher = fetcher; this.base = 'https://api.audius.co/v1'; this.cooldown = 0; }
  async request(path) {
    if (Date.now() < this.cooldown) throw new MusicError('RATE_LIMIT', 'Audius is rate limited. Try later.');
    const r = await this.fetcher(`${this.base}${path}${path.includes('?') ? '&' : '?'}app_name=Lancy`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) { this.cooldown = Date.now() + Math.max(1, Number(r.headers.get('retry-after')) || 60) * 1000; throw new MusicError('RATE_LIMIT', 'Audius is rate limited. Try later.'); }
    if (!r.ok) throw new MusicError('PROVIDER_FAILURE', 'Audius is temporarily unavailable.');
    return (await r.json()).data;
  }
  normalize(x) { return normalizeTrack({ providerId: x.id, title: x.title, artist: x.user?.name, durationSeconds: x.duration, artwork: x.artwork?.['480x480'], sourceRef: x.permalink ? `https://audius.co${x.permalink}` : null, availability: x.is_available === false ? 'unavailable' : 'unresolved', downloadable: x.is_downloadable === true && !x.is_download_gated, streamable: x.is_streamable === true && !x.is_stream_gated }, this.id); }
  async search(query, { offset = 0, limit = 5 } = {}) {
    if (/^https?:/i.test(query)) throw new MusicError('UNSUPPORTED_URL', 'For Audius, search by title and artist.');
    const data = await this.request(`/tracks/search?query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit + 1}`);
    const items = (data || []).map(x => this.normalize(x)).filter(x => x.availability !== 'unavailable' && x.streamable !== false);
    return { items: items.slice(0, limit), nextOffset: items.length > limit && offset + limit < 100 ? offset + limit : null };
  }
  async media(track, { download = false } = {}) {
    if (!/^[a-zA-Z0-9]+$/.test(track.providerId)) throw new MusicError('INVALID_TRACK', 'Invalid track identifier.');
    const meta = this.normalize(await this.request(`/tracks/${track.providerId}`));
    if (meta.providerId !== track.providerId) throw new MusicError('TRACK_MISMATCH', 'The provider returned a different recording.');
    if (meta.availability === 'unavailable' || !(download ? meta.downloadable : meta.streamable)) throw new MusicError('RESTRICTED', download ? 'This artist has not enabled an ungated download for this recording.' : 'This recording is not available for ungated streaming.');
    return { track: meta, url: `${this.base}/tracks/${track.providerId}/${download ? 'download' : 'stream'}?app_name=Lancy` };
  }
}
export class PlayMusicProvider {
  constructor({ runner = exec } = {}) {
    this.id = 'music';
    this.runner = runner;
  }
  async search(query, { offset = 0, limit = 5 } = {}) {
    const clean = String(query || '')
      .replace(/^(music|song|track|audio|play):\s*/i, '')
      .trim();
    if (!clean) throw new MusicError('EMPTY_QUERY', 'Search by song title, artist, or music genre.');
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&entity=song&limit=30`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        const items = (data?.results || [])
          .filter(t => t?.trackName && t?.artistName && t?.trackTimeMillis >= 40000 && t?.trackTimeMillis <= 900000)
          .map(t => normalizeTrack({
            providerId: String(t.trackId || createHash('sha256').update(`${t.artistName}-${t.trackName}`).digest('hex').slice(0, 16)),
            title: t.trackName,
            artist: t.artistName,
            album: t.collectionName || null,
            durationSeconds: Math.round(t.trackTimeMillis / 1000),
            artwork: t.artworkUrl100?.replace('100x100bb', '600x600bb') || t.artworkUrl100 || null,
            sourceRef: t.trackViewUrl || null,
            availability: 'unresolved',
            capabilities: { stream: true, download: true, seek: true, video: false }
          }, this.id));
        if (items.length > offset) {
          return {
            items: items.slice(offset, offset + limit),
            nextOffset: items.length > offset + limit && offset + limit < 30 ? offset + limit : null
          };
        }
      }
    } catch {}
    return { items: [], nextOffset: null };
  }
  async download(track, path, { video = false, maxBytes = 48 * 1024 * 1024 } = {}) {
    const cleanQuery = `${track.artist || ''} ${track.title}`.trim();
    const diskCachePattern = `/data/audio_cache/${track.providerId}.mp3`;
    if (existsSync(diskCachePattern) && statSync(diskCachePattern).size > 40000) {
      const buf = readFileSync(diskCachePattern);
      writeFileSync(path, buf);
      return normalizeTrack({ ...track, filePath: path, availability: 'resolved' }, this.id);
    }
    let matchedVideoId = null;
    try {
      const fastItems = await searchYouTubeFast(`${cleanQuery} official audio`, 'NG', { wide: true });
      const best = (fastItems || []).find(v => !v.isLive && v.duration !== 'LIVE' && v.duration !== 'HD');
      if (best?.videoId) matchedVideoId = best.videoId;
    } catch {}

    const targetUrl = matchedVideoId ? `https://www.youtube.com/watch?v=${matchedVideoId}` : `ytsearch1:${cleanQuery} audio`;
    const cookieArgs = existsSync('/data/youtube_cookies.txt') ? ['--cookies', '/data/youtube_cookies.txt'] : [];

    const buildArgs = (target) => {
      const a = [
        '--ignore-config',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--socket-timeout', '15',
        '--retries', '2',
        '--fragment-retries', '2',
        '--max-filesize', String(maxBytes),
        '--match-filter', 'duration <= 900 & !is_live',
        '--restrict-filenames',
        '-f', 'ba/b',
        '-o', path,
        '--print', 'after_move:%()j'
      ];
      if (this.runner === exec) {
        if (existsSync('/usr/bin/node')) a.push('--js-runtimes', 'node:/usr/bin/node');
        if (existsSync('/data/cache/yt-dlp')) a.push('--cache-dir', '/data/cache/yt-dlp');
        if (cookieArgs.length) a.push(...cookieArgs);
      }
      a.push('--', target);
      return a;
    };

    try {
      await this.runner('yt-dlp', buildArgs(targetUrl), { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    } catch (ytErr) {
      try {
        await this.runner('yt-dlp', buildArgs(`scsearch1:${cleanQuery}`), { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      } catch {
        throw ytErr;
      }
    }
    return normalizeTrack({
      ...track,
      filePath: path,
      availability: 'resolved',
      capabilities: { stream: true, download: true, seek: true, video: false }
    }, this.id);
  }
}
export class ProviderRegistry {
  constructor(providers = [new PlayMusicProvider(), new AudiusProvider(), new YouTubeProvider()]) { this.adapters = new Map(providers.map(p => [p.id, p])); }
  get(id) { const p = this.adapters.get(id); if (!p) throw new MusicError('UNSUPPORTED_PROVIDER', 'Unsupported music provider.'); return p; }
  async search(query, options) {
    const m = String(query).match(/^(youtube|yt|audius|music|itunes):\s*(.+)$/i);
    const explicit = Boolean(m);
    const prefix = m ? m[1].toLowerCase() : null;
    let provider;
    if (explicit) {
      provider = prefix === 'yt' ? 'youtube' : (prefix === 'itunes' ? 'music' : prefix);
    } else if (options?.video || youtubeId(query)) {
      provider = 'youtube';
    } else if (options?.radio || options?.filterDuration === 'song' || options?.filterDuration === 'medium') {
      provider = this.adapters.has('music') ? 'music' : (this.get('youtube').enabled ? 'youtube' : 'audius');
    } else {
      provider = this.adapters.has('music') ? 'music' : (this.get('youtube').enabled ? 'youtube' : 'audius');
    }
    if (options?.video && provider !== 'youtube') throw new MusicError('VIDEO_UNSUPPORTED', 'Choose a permitted YouTube video, or reply /vidc to a video file. Audius and Music are audio-only.');
    if (options?.video && !this.get('youtube').enabled) throw new MusicError('PROVIDER_DISABLED', 'Video search requires owner-enabled permitted YouTube resolution. You can still reply /vidc to a video file.');
    const q = m ? m[2] : query;
    try {
      const res = await this.get(provider).search(q, options);
      if ((res.items && res.items.length > 0) || explicit || youtubeId(query)) {
        return { ...res, provider };
      }
    } catch (err) {
      if (explicit || youtubeId(query)) throw err;
      const fallback = provider === 'music' ? (this.adapters.get('youtube')?.enabled ? 'youtube' : 'audius') : (provider === 'youtube' ? 'audius' : (this.adapters.get('youtube')?.enabled ? 'youtube' : null));
      if (fallback && this.adapters.has(fallback)) {
        try {
          const fallbackRes = await this.get(fallback).search(q, options);
          if (fallbackRes.items && fallbackRes.items.length > 0) return { ...fallbackRes, provider: fallback };
        } catch {}
      }
      throw err;
    }
    const fallback = provider === 'music' ? (this.adapters.get('youtube')?.enabled ? 'youtube' : 'audius') : (provider === 'youtube' ? 'audius' : (this.adapters.get('youtube')?.enabled ? 'youtube' : null));
    if (fallback && this.adapters.has(fallback)) {
      try {
        const fallbackRes = await this.get(fallback).search(q, options);
        if (fallbackRes.items && fallbackRes.items.length > 0) return { ...fallbackRes, provider: fallback };
      } catch {}
    }
    return { ...(await this.get(provider).search(q, options)), provider };
  }
}
