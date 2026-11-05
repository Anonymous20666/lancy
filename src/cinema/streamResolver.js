import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);

export class CinemaStreamResolver {
  constructor({ app, log, cacheTtlMs = 3600000 } = {}) {
    this.app = app;
    this.log = log || logger().child({ module: 'cinema:stream-resolver' });
    this.cache = new Map(); // key -> { data, expiresAt }
    this.cacheTtlMs = cacheTtlMs;
  }

  getCacheKey(mediaType, mediaId, season, episode) {
    return `${mediaType || 'movie'}_${mediaId}_${season || 0}_${episode || 0}`;
  }

  isDirectMedia(url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(m3u8|mp4|webm|mkv|ts)(\?|$)/i.test(url);
  }

  async probeUrl(url, timeoutMs = 5000) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height',
        '-of', 'json',
        url
      ], { timeout: timeoutMs });

      const parsed = JSON.parse(stdout);
      const streams = parsed.streams || [];
      const hasVideo = streams.some((s) => s.codec_type === 'video');
      const hasAudio = streams.some((s) => s.codec_type === 'audio');

      return {
        valid: hasVideo && hasAudio,
        hasVideo,
        hasAudio,
        duration: parseFloat(parsed.format?.duration || 0),
        formatName: parsed.format?.format_name || 'unknown'
      };
    } catch (err) {
      this.log.debug({ err: err?.message, url }, 'ffprobe failed on stream URL');
      return { valid: false, err: err?.message };
    }
  }

  async resolve({
    mediaType = 'movie',
    mediaId,
    season = null,
    episode = null,
    sourceUrl = null,
    preferredServer = null
  } = {}) {
    // 1. Direct media URL already provided
    if (sourceUrl && this.isDirectMedia(sourceUrl)) {
      return {
        ok: true,
        streamUrl: sourceUrl,
        format: sourceUrl.includes('.m3u8') ? 'hls' : 'direct',
        isHls: sourceUrl.includes('.m3u8'),
        cached: false
      };
    }

    // 2. Check in-memory cache
    const cacheKey = this.getCacheKey(mediaType, mediaId, season, episode);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return { ...cached.data, cached: true };
    }

    // 3. Query Movie API Playback endpoint
    if (!this.app?.movieApi) {
      throw new Error('Movie API client is not initialized');
    }

    const playbackData = await this.app.movieApi.getPlayback(mediaId, {
      type: mediaType,
      season,
      episode
    });

    if (!playbackData || (!playbackData.available && !playbackData.embed_url && !playbackData.servers?.length)) {
      throw new Error('No streaming servers available for this title');
    }

    let candidateUrl = sourceUrl;
    let format = 'embed';

    // Prioritize direct servers or default server
    const servers = playbackData.servers || [];
    if (preferredServer) {
      const found = servers.find((s) => s.id === preferredServer);
      if (found?.url) candidateUrl = found.url;
    }

    if (!candidateUrl) {
      candidateUrl = playbackData.embed_url || servers[0]?.url || playbackData.viewing_url;
    }

    if (!candidateUrl) {
      throw new Error('Could not find a valid stream URL in Movie API response');
    }

    // Check if candidate URL is direct media
    if (this.isDirectMedia(candidateUrl)) {
      format = candidateUrl.includes('.m3u8') ? 'hls' : 'mp4';
    }

    const resolved = {
      ok: true,
      streamUrl: candidateUrl,
      format,
      isHls: format === 'hls',
      qualities: playbackData.qualities || ['1080p Full HD', '720p HD'],
      subtitles: playbackData.subtitles || ['English'],
      cached: false
    };

    // Store in cache
    this.cache.set(cacheKey, {
      data: resolved,
      expiresAt: Date.now() + this.cacheTtlMs
    });

    return resolved;
  }
}
