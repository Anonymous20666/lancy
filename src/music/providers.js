import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeTrack, MusicError } from './model.js';
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
  async search(query, { offset = 0, limit = 5 } = {}) {
    this.assertEnabled();
    const direct = youtubeId(query);
    if (/^https?:/i.test(query) && !direct) throw new MusicError('UNSUPPORTED_URL', 'Use a supported HTTPS YouTube video URL; playlists and arbitrary URLs are not accepted.');
    const end = Math.min(offset + limit + 1, 30);
    const target = direct ? `https://www.youtube.com/watch?v=${direct}` : `ytsearch${end}:${String(query).slice(0, 180)}`;
    if (direct && offset) return { items: [], nextOffset: null };
    const { stdout } = await this.runner('yt-dlp', ['--ignore-config', '--no-warnings', '--skip-download', '--flat-playlist', '--dump-single-json', '--playlist-start', String(offset + 1), '--playlist-end', String(end), '--socket-timeout', '10', '--', target], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout); const entries = info.entries || [info];
    const items = entries.filter(x => /^[\w-]{11}$/.test(x?.id || '')).map(x => normalizeTrack({ providerId: x.id, title: x.track || x.title, artist: x.artist || x.uploader || x.channel, durationSeconds: x.duration, artwork: x.thumbnail || x.thumbnails?.at(-1)?.url, sourceRef: `https://www.youtube.com/watch?v=${x.id}`, availability: 'unresolved' }, this.id));
    return { items: items.slice(0, limit), nextOffset: !direct && items.length > limit && offset + limit < 30 ? offset + limit : null };
  }
  async download(track, path, { video = false, maxBytes = 48 * 1024 * 1024 } = {}) {
    this.assertEnabled();
    if (!/^[\w-]{11}$/.test(track.providerId)) throw new MusicError('INVALID_TRACK', 'Invalid track identifier.');
    const target = `https://www.youtube.com/watch?v=${track.providerId}`;
    const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2', '--max-filesize', String(maxBytes), '--match-filter', 'duration <= 7200 & !is_live', '--restrict-filenames', '-f', video ? 'bv*[height<=360]+ba/b[height<=360]' : 'bestaudio/best', '-o', path, '--print', 'after_move:%()j', '--', target];
    if (video) args.splice(args.length - 2, 0, '--merge-output-format', 'mp4');
    const { stdout } = await this.runner('yt-dlp', args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout.trim().split('\n').at(-1));
    if (info.id !== track.providerId) throw new MusicError('TRACK_MISMATCH', 'The media provider returned a different recording.');
    return normalizeTrack({ ...track, title: info.track || info.title || track.title, artist: info.artist || info.uploader || track.artist, album: info.album, durationSeconds: info.duration, availability: 'resolved', capabilities: { stream: true, download: true, seek: true, video } }, this.id);
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
    const items = (data || []).map(x => this.normalize(x));
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
export class ProviderRegistry {
  constructor(providers = [new AudiusProvider(), new YouTubeProvider()]) { this.adapters = new Map(providers.map(p => [p.id, p])); }
  get(id) { const p = this.adapters.get(id); if (!p) throw new MusicError('UNSUPPORTED_PROVIDER', 'Unsupported music provider.'); return p; }
  async search(query, options) {
    const m = String(query).match(/^(youtube|yt|audius):\s*(.+)$/i);
    const provider = m ? (m[1].toLowerCase() === 'yt' ? 'youtube' : m[1].toLowerCase()) : (options?.video||youtubeId(query)) ? 'youtube' : this.get('youtube').enabled ? 'youtube' : 'audius';
    if(options?.video&&provider!=='youtube')throw new MusicError('VIDEO_UNSUPPORTED','Choose a permitted YouTube video, or reply /vidc to a video file. Audius is audio-only.');
    if(options?.video&&!this.get('youtube').enabled)throw new MusicError('PROVIDER_DISABLED','Video search requires owner-enabled permitted YouTube resolution. You can still reply /vidc to a video file.');
    return { ...(await this.get(provider).search(m ? m[2] : query, options)), provider };
  }
}
