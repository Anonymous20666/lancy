import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);

export class CinemaStreamResolver {
  constructor({ app, log, cacheTtlMs = 3600000, videoCacheDir = '/data/video_cache' } = {}) {
    this.app = app;
    this.log = log || logger().child({ module: 'cinema:stream-resolver' });
    this.cache = new Map(); // key -> { data, expiresAt }
    this.cacheTtlMs = cacheTtlMs;
    this.videoCacheDir = videoCacheDir;
    this.preloadInFlight = new Map(); // key -> Promise
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

  async resolvePlayableLocalFile({ mediaType = 'movie', mediaId, title, trailerUrl }) {
    try {
      mkdirSync(this.videoCacheDir, { recursive: true });
      const safeKey = `cinema_${mediaType}_${String(mediaId).replace(/[^a-zA-Z0-9_-]/g, '')}`;
      const targetPath = join(this.videoCacheDir, `${safeKey}.mp4`);

      if (existsSync(targetPath) && statSync(targetPath).size > 20000) {
        return targetPath;
      }

      const targetYt = trailerUrl && /youtube\.com|youtu\.be/i.test(trailerUrl)
        ? trailerUrl
        : (title ? `ytsearch1:${title} official trailer` : null);
      if (!targetYt) return null;

      await execFileAsync('yt-dlp', [
        '--no-warnings',
        '--no-playlist',
        '-f', 'best[ext=mp4][height<=480]/best[ext=mp4]/best',
        '--max-filesize', '45M',
        '--js-runtimes', 'node:/usr/bin/node',
        '-o', targetPath,
        targetYt
      ], { timeout: 25000 });

      if (existsSync(targetPath) && statSync(targetPath).size > 20000) {
        return targetPath;
      }
    } catch (err) {
      this.log.debug({ err: err?.message, mediaId }, 'Optional trailer/media file cache skipped');
    }
    return null;
  }

  async preloadNext(nextItem) {
    if (!nextItem || !nextItem.mediaId) return null;
    const key = this.getCacheKey(nextItem.mediaType, nextItem.mediaId, nextItem.season, nextItem.episode);
    if (this.preloadInFlight.has(key)) return this.preloadInFlight.get(key);
    if (this.cache.has(key)) return this.cache.get(key)?.data || null;

    // Bounded to 1 concurrent preload so current movie retains priority
    if (this.preloadInFlight.size >= 1) return null;

    const task = this.resolve({
      mediaType: nextItem.mediaType || 'movie',
      mediaId: nextItem.mediaId,
      season: nextItem.season,
      episode: nextItem.episode
    }).catch((err) => {
      this.log.debug({ err: err?.message, key }, 'Background next-item preload failed harmlessly');
      return null;
    }).finally(() => {
      this.preloadInFlight.delete(key);
    });

    this.preloadInFlight.set(key, task);
    return task;
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

    const servers = playbackData.servers || [];
    if (preferredServer) {
      const found = servers.find((s) => s.id === preferredServer);
      if (found?.url) candidateUrl = found.url;
    }

    // Prefer direct media server if present
    if (!candidateUrl) {
      const directServer = servers.find((s) => this.isDirectMedia(s.url));
      candidateUrl = directServer?.url || playbackData.embed_url || servers[0]?.url || playbackData.viewing_url;
    }

    if (!candidateUrl) {
      throw new Error('Could not find a valid stream URL in Movie API response');
    }

    if (this.isDirectMedia(candidateUrl)) {
      format = candidateUrl.includes('.m3u8') ? 'hls' : 'mp4';
    }

    const resolved = {
      ok: true,
      streamUrl: candidateUrl,
      format,
      isHls: format === 'hls',
      servers: servers.map(s => ({ id: s.id, name: s.name || s.id, isDefault: Boolean(s.isDefault) })),
      qualities: playbackData.qualities || ['1080p Full HD', '720p HD'],
      subtitles: playbackData.subtitles || ['English'],
      cached: false
    };

    if (this.cache.size >= 200) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(cacheKey, {
      data: resolved,
      expiresAt: Date.now() + this.cacheTtlMs
    });

    return resolved;
  }
}
