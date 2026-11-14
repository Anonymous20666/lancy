import http from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, createReadStream, writeFileSync, unlinkSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDurationToSeconds } from '../utils/time.js';
import { optimizeVideoForTelegram, getCookieArgs, getAudioDurationSeconds } from './downloader.js';
import { resolveAndDownloadAudio } from './musicResolver.js';
import { resolveFfmpegPath } from './convert.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_STREAM_PUBLIC_URL = 'https://pappysonghttps.duckdns.org';

/**
 * Resolve the public HTTPS base URL for streamed audio/video assets.
 * Honors `STREAM_PUBLIC_URL` env override first, then settings `media.streamPublicUrl`.
 */
export function getStreamPublicUrl(settings) {
  const raw = process.env.STREAM_PUBLIC_URL
    || settings?.get?.('media.streamPublicUrl')
    || DEFAULT_STREAM_PUBLIC_URL;
  return String(raw).trim().replace(/\/+$/, '');
}

/**
 * High-Performance Video & Audio Streaming Server for Telegram Bot API
 * Listens on 127.0.0.1:3055 and dynamically streams H.264 MP4 videos and
 * ID3v2-tagged MP3 audio tracks with full HTTP Range (206 Partial Content) support.
 */
export class VideoStreamingServer {
  constructor({ app, port = 3055, cacheDir = '/data/video_cache', audioCacheDir = '/data/audio_cache', log } = {}) {
    this.app = app;
    this.port = port;
    this.cacheDir = cacheDir;
    this.audioCacheDir = audioCacheDir;
    this.log = log || app?.log;
    this.server = null;
    this.activeDownloads = new Map();
    this.activeAudioDownloads = new Map();
    this.remoteStreams = new Map();
    this.segmentCache = new Map();
    this.segmentCacheBytes = 0;
    this.inflightSegments = new Map();

    try {
      mkdirSync(this.cacheDir, { recursive: true });
      mkdirSync(this.audioCacheDir, { recursive: true });
    } catch {}
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.#handleRequest(req, res);
        } catch (err) {
          this.log?.error?.({ err: err?.message, url: req.url }, 'video streaming request error');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Streaming error');
          }
        }
      });

      this.server.on('error', (err) => {
        this.log?.error?.({ err: err?.message, port: this.port }, 'video streaming server failed');
        reject(err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object' && addr.port) this.port = addr.port;
        this.log?.info?.({ port: this.port }, 'video streaming server listening on 127.0.0.1');
        resolve(this.server);
      });
    });
  }

  async stop() {
    this.segmentCache.clear();
    this.segmentCacheBytes = 0;
    this.inflightSegments.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  async #handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, service: 'video-streamer', time: Date.now() }));
      return;
    }

    // 1. Audio stream request (/audio/:id(.mp3)?/:filename? or /audio/live/:id/:filename?)
    const audioMatch = pathname.match(/^\/audio\/(?:live\/)?([a-zA-Z0-9_-]+?)(?:\.mp3)?(?:\/([^\/]+))?$/i);
    if (audioMatch) {
      const trackId = audioMatch[1];
      const filename = audioMatch[2] ? decodeURIComponent(audioMatch[2]) : `${trackId}.mp3`;
      let filePath = join(this.audioCacheDir, `${trackId}.mp3`);

      if (!existsSync(filePath) || statSync(filePath).size < 1000) {
        filePath = await this.#ensureAudioCached(trackId, filename);
      }

      if (!filePath || !existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Audio not found');
        return;
      }

      this.#serveMediaFile(req, res, filePath, 'audio/mpeg', filename);
      return;
    }

    // 1.5 Loopback progressive movie/episode relay (/movie-proxy/:token[.ext]) for PyTgCalls
    const proxyMatch = pathname.match(/^\/movie-proxy\/([a-f0-9]{16,64})(?:\.(?:m3u8|ts|mp4|mkv|m4s|aac|key))?$/i);
    if (proxyMatch) {
      await this.#handleMovieProxy(req, res, proxyMatch[1]);
      return;
    }

    // 2. Video stream request (/video/:id or /stream/:id)
    const videoMatch = pathname.match(/^\/(?:video|stream)\/([a-zA-Z0-9_-]+)(?:\.mp4)?$/i);
    if (!videoMatch) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Not Found');
      return;
    }

    const videoId = videoMatch[1];
    let filePath = join(this.cacheDir, `${videoId}.mp4`);

    if (!existsSync(filePath)) {
      // Check if file exists in /data/video_serve/video/
      const servePath = join('/data/video_serve/video', `${videoId}.mp4`);
      if (existsSync(servePath)) {
        filePath = servePath;
      } else {
        // Dynamically download and transcode video
        filePath = await this.#ensureVideoCached(videoId);
      }
    }

    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Video not found');
      return;
    }

    this.#serveMediaFile(req, res, filePath, 'video/mp4', `${videoId}.mp4`);
  }

  async #ensureVideoCached(videoId) {
    if (this.activeDownloads.has(videoId)) {
      return this.activeDownloads.get(videoId);
    }

    const downloadPromise = (async () => {
      try {
        const targetPath = join(this.cacheDir, `${videoId}.mp4`);
        if (existsSync(targetPath)) return targetPath;

        const downloader = this.app?.mediaDownloader;
        if (!downloader) return null;

        const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const res = await downloader.download(targetUrl).catch(() => null);
        const videoItem = res?.mediaItems?.find((m) => m.type === 'video');

        if (videoItem?.buffer && videoItem.buffer.length > 1024) {
          let optimized = null;
          try {
            optimized = await optimizeVideoForTelegram(videoItem.buffer);
          } catch {}
          const finalBuffer = optimized || videoItem.buffer;
          writeFileSync(targetPath, finalBuffer);

          // If a dedicated storage channel is configured, upload and cache file_id (never upload to owner's personal chat)
          const api = this.app?.telegram?.api;
          const storageChatId = this.app?.settings?.get('telegram.storageChatId') || this.app?.settings?.get('telegram.storageChannelId');
          const durSec = res.duration ? parseDurationToSeconds(res.duration) : 30;

          if (api && storageChatId) {
            (async () => {
              try {
                const sent = await api.sendVideo(storageChatId, finalBuffer, {
                  caption: `🎬 ${res.title || 'Clip'}`,
                  duration: durSec > 0 ? durSec : 30,
                  supports_streaming: true,
                  disable_notification: true
                });
                const fileId = sent?.video?.file_id;
                if (fileId) {
                  if (sent.message_id) {
                    await api.call('deleteMessage', { chat_id: storageChatId, message_id: sent.message_id }).catch(() => {});
                  }
                  const db = this.app?.db;
                  if (db) {
                    const sql = 'INSERT OR REPLACE INTO cached_video_tracks (query, file_id, title, duration) VALUES (?, ?, ?, ?)';
                    db.run(sql, videoId, fileId, res.title || 'Clip', durSec);
                  }
                }
              } catch {}
            })();
          }

          return targetPath;
        }
      } catch (err) {
        this.log?.debug?.({ err: err?.message, videoId }, 'streaming server download failed');
      } finally {
        this.activeDownloads.delete(videoId);
      }
      return null;
    })();

    this.activeDownloads.set(videoId, downloadPromise);
    return downloadPromise;
  }

  async #ensureAudioCached(trackId, filename) {
    if (this.activeAudioDownloads.has(trackId)) {
      return this.activeAudioDownloads.get(trackId);
    }

    const downloadPromise = (async () => {
      try {
        const targetPath = join(this.audioCacheDir, `${trackId}.mp3`);
        if (existsSync(targetPath)) {
          const sz = statSync(targetPath).size;
          if (sz > 50000) {
            // Verify file has full duration (not an old 30-second preview)
            const dur = await getAudioDurationSeconds(targetPath);
            if (dur === null || dur >= 45) {
              return targetPath;
            }
            // Remove old truncated preview so full track is downloaded
            try { unlinkSync(targetPath); } catch {}
          }
        }

        // Retrieve metadata from telegram bot controller
        let meta = this.app?.telegram?.controller?.getInlineAudioMetadata?.(trackId)
          || this.app?.telegram?.getInlineAudioMetadata?.(trackId)
          || this.app?.telegram?.audioMetadataMap?.get?.(String(trackId));

        const isYouTubeId = /^[a-zA-Z0-9_-]{11}$/.test(trackId);
        const searchQuery = meta
          ? `${meta.title} ${meta.artist}`.trim()
          : (filename ? filename.replace(/\.mp3$/i, '').replace(/_/g, ' ').trim() : trackId);

        const cookieArgs = getCookieArgs();
        const ffmpegPath = resolveFfmpegPath(this.app?.settings?.get('media.ffmpegPath') ?? '') || 'ffmpeg';
        const tempStem = join(this.audioCacheDir, `temp_full_${trackId}_${Date.now()}`);
        const tempPath = `${tempStem}.mp3`;

        // Multi-source full-track resolution (YouTube exact-id -> JioSaavn / Audius),
        // duration-validated >= 45s so 30s previews can never leak through.
        let downloaded = false;
        try {
          const resolved = await resolveAndDownloadAudio({
            query: searchQuery,
            trackId: isYouTubeId ? trackId : null,
            tempPath,
            minSeconds: 45,
            ffmpegPath,
          });
          downloaded = resolved.ok;
          if (resolved.ok) {
            meta = meta ?? (resolved.meta?.title ? { title: resolved.meta.title, artist: resolved.meta.artist ?? 'Music' } : meta);
          } else {
            this.log?.warn?.({ trackId, searchQuery }, 'multi-source resolver exhausted; falling back to ytsearch1');
          }
        } catch (rErr) {
          this.log?.warn?.({ err: rErr?.message, trackId }, 'music resolver crashed; falling back');
        }

        if (!downloaded) {
          try {
            await execFileAsync('yt-dlp', [
              '--no-warnings',
              '--no-playlist',
              '--ffmpeg-location', ffmpegPath,
              ...cookieArgs,
              '-N', '4',
              '--max-filesize', '50M',
              '--js-runtimes', 'node:/usr/bin/node',
              '-f', 'ba[ext=m4a]/ba/b',
              '-x',
              '--audio-format', 'mp3',
              '--audio-quality', '2',
              '-o', `${tempStem}.%(ext)s`,
              isYouTubeId ? `https://www.youtube.com/watch?v=${trackId}` : `ytsearch1:${searchQuery}`
            ], { timeout: 45000 });

            if (existsSync(tempPath) && statSync(tempPath).size > 10000) {
              downloaded = true;
            }
          } catch (dlErr) {
            this.log?.warn?.({ err: dlErr?.message, trackId }, 'yt-dlp direct audio download failed, attempting mediaDownloader fallback');
          }
        }

        if (!downloaded && this.app?.mediaDownloader) {
          try {
            const dlTarget = isYouTubeId ? `https://www.youtube.com/watch?v=${trackId}` : searchQuery;
            const res = await this.app.mediaDownloader.download(dlTarget);
            if (res?.audioTrack?.buffer && res.audioTrack.buffer.length > 10000) {
              writeFileSync(tempPath, res.audioTrack.buffer);
              downloaded = true;
            }
          } catch (mErr) {
            this.log?.debug?.({ err: mErr?.message, trackId }, 'mediaDownloader audio fallback failed');
          }
        }

        if (downloaded && existsSync(tempPath)) {
          // Tag with ID3v2 if metadata available
          const titleStr = meta?.title || searchQuery;
          const artistStr = meta?.artist || 'Music';
          try {
            await execFileAsync(ffmpegPath, [
              '-y',
              '-i', tempPath,
              '-metadata', `title=${titleStr}`,
              '-metadata', `artist=${artistStr}`,
              '-id3v2_version', '3',
              '-c', 'copy',
              targetPath
            ]);
            try { unlinkSync(tempPath); } catch {}
          } catch {
            renameSync(tempPath, targetPath);
          }

          // If a storage channel is configured, cache to Telegram in background
          (async () => {
            try {
              const api = this.app?.telegram?.api;
              const storageChatId = this.app?.settings?.get('telegram.storageChatId') || this.app?.settings?.get('telegram.storageChannelId');
              if (api && storageChatId && existsSync(targetPath)) {
                const fullBuf = statSync(targetPath).size > 10000 ? readFileSync(targetPath) : null;
                if (fullBuf) {
                  const fileDur = await getAudioDurationSeconds(targetPath);
                  const durSec = fileDur ? Math.round(fileDur) : (meta?.duration || 0);
                  const sent = await api.sendAudio(storageChatId, fullBuf, {
                    title: titleStr,
                    performer: artistStr,
                    ...(durSec > 0 ? { duration: durSec } : {}),
                    disable_notification: true
                  }).catch(() => null);
                  const uploadedFileId = sent?.audio?.file_id;
                  if (uploadedFileId) {
                    if (sent.message_id) {
                      await api.call('deleteMessage', { chat_id: storageChatId, message_id: sent.message_id }).catch(() => {});
                    }
                    const db = this.app?.db;
                    if (db) {
                      const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
                      if (isYouTubeId) db.run(sql, trackId, uploadedFileId, titleStr, artistStr, durSec);
                      db.run(sql, searchQuery.toLowerCase().trim(), uploadedFileId, titleStr, artistStr, durSec);
                      const cleanT = (titleStr || '').toLowerCase().trim();
                      if (cleanT && cleanT !== searchQuery.toLowerCase().trim()) {
                        db.run(sql, cleanT, uploadedFileId, titleStr, artistStr, durSec);
                      }
                    }
                  }
                }
              }
            } catch {}
          })();

          return targetPath;
        }

        return null;
      } catch (err) {
        this.log?.debug?.({ err: err?.message, trackId }, 'ensureAudioCached failed');
      } finally {
        this.activeAudioDownloads.delete(trackId);
      }
      return null;
    })();

    this.activeAudioDownloads.set(trackId, downloadPromise);
    return downloadPromise;
  }

  registerRemoteStream({ url, headers = {}, contentType = 'video/mp4', isHls = false, ttlMs = 8 * 3600 * 1000 } = {}) {
    if (!url || !/^https?:\/\//i.test(String(url))) return null;
    const now = Date.now();
    for (const [k, v] of this.remoteStreams) {
      if (now > v.expiresAt) this.remoteStreams.delete(k);
    }
    const token = randomBytes(16).toString('hex');
    const urlStr = String(url);
    const detectedHls = Boolean(isHls || /mpegurl/i.test(String(contentType || '')) || /\.m3u8(\?|$)/i.test(urlStr));
    this.remoteStreams.set(token, {
      url: urlStr,
      headers: headers && typeof headers === 'object' ? { ...headers } : {},
      contentType: detectedHls ? 'application/vnd.apple.mpegurl' : contentType,
      isHls: detectedHls,
      forceContentType: null,
      childTokens: new Map(),
      expiresAt: now + ttlMs
    });
    return `http://127.0.0.1:${this.port}/movie-proxy/${token}`;
  }

  #registerChildProxyStream(parentEntry, targetUrl, { isHls = false, contentType = 'video/mp2t', forceContentType = null } = {}) {
    const absUrl = String(targetUrl);
    const existing = parentEntry.childTokens?.get(absUrl);
    const now = Date.now();
    if (existing) {
      const existingEntry = this.remoteStreams.get(existing);
      if (existingEntry && now <= existingEntry.expiresAt) {
        return existing;
      }
    }
    if (this.remoteStreams.size > 6000) {
      for (const [k, v] of this.remoteStreams) {
        if (now > v.expiresAt) this.remoteStreams.delete(k);
      }
      if (this.remoteStreams.size > 6000) {
        for (const [k, v] of this.remoteStreams) {
          if (v.isChildSegment) {
            this.remoteStreams.delete(k);
            if (this.remoteStreams.size <= 4500) break;
          }
        }
      }
    }
    const childToken = randomBytes(16).toString('hex');
    this.remoteStreams.set(childToken, {
      url: absUrl,
      headers: parentEntry.headers ? { ...parentEntry.headers } : {},
      contentType,
      isHls: Boolean(isHls),
      forceContentType,
      isChildSegment: !isHls,
      childTokens: new Map(),
      expiresAt: parentEntry.expiresAt
    });
    parentEntry.childTokens?.set(absUrl, childToken);
    return childToken;
  }

  #rewriteHlsPlaylist(text, baseUrl, parentEntry) {
    const lines = String(text || '').split(/\r?\n/);
    const hasInitMap = /^#EXT-X-MAP:/im.test(text);
    const base = `http://127.0.0.1:${this.port}/movie-proxy`;
    let expectVariantPlaylist = false;

    const rewriteUri = (rawUri, opts) => {
      try {
        const abs = new URL(rawUri, baseUrl).toString();
        const tok = this.#registerChildProxyStream(parentEntry, abs, opts);
        return `${base}/${tok}.${opts.ext}`;
      } catch {
        return rawUri;
      }
    };

    return lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        expectVariantPlaylist = /^#EXT-X-STREAM-INF\b/i.test(trimmed);
        if (/^#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF)\b/i.test(trimmed) && /\bURI="([^"]+)"/i.test(line)) {
          const isSubPlaylist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)\b/i.test(trimmed);
          const isKey = /^#EXT-X-KEY\b/i.test(trimmed);
          const isMap = /^#EXT-X-MAP\b/i.test(trimmed);
          const opts = isSubPlaylist
            ? { isHls: true, contentType: 'application/vnd.apple.mpegurl', forceContentType: 'application/vnd.apple.mpegurl', ext: 'm3u8' }
            : isKey
              ? { isHls: false, contentType: 'application/octet-stream', forceContentType: 'application/octet-stream', ext: 'key' }
              : isMap
                ? { isHls: false, contentType: 'video/mp4', forceContentType: 'video/mp4', ext: 'mp4' }
                : { isHls: false, contentType: 'video/mp2t', forceContentType: 'video/mp2t', ext: 'ts' };
          return line.replace(/\bURI="([^"]+)"/i, (_, u) => `URI="${rewriteUri(u, opts)}"`);
        }
        return line;
      }

      if (expectVariantPlaylist) {
        expectVariantPlaylist = false;
        return rewriteUri(trimmed, {
          isHls: true,
          contentType: 'application/vnd.apple.mpegurl',
          forceContentType: 'application/vnd.apple.mpegurl',
          ext: 'm3u8'
        });
      }

      let isFmp4 = hasInitMap || /\.m4s(\?|$)/i.test(trimmed);
      if (!isFmp4) {
        try {
          const nested = new URL(trimmed, baseUrl).searchParams.get('url') || '';
          if (/\.m4s(\?|$)/i.test(nested)) isFmp4 = true;
        } catch {}
      }
      return rewriteUri(trimmed, isFmp4
        ? { isHls: false, contentType: 'video/mp4', forceContentType: 'video/mp4', ext: 'm4s' }
        : { isHls: false, contentType: 'video/mp2t', forceContentType: 'video/mp2t', ext: 'ts' });
    }).join('\n');
  }

  #getCachedSegment(token) {
    const item = this.segmentCache.get(token);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.segmentCache.delete(token);
      this.segmentCacheBytes = Math.max(0, this.segmentCacheBytes - item.body.length);
      return null;
    }
    return item;
  }

  #putCachedSegment(token, body, contentType) {
    const maxEntry = 12 * 1024 * 1024;
    const maxTotal = 48 * 1024 * 1024;
    if (!Buffer.isBuffer(body) || !body.length || body.length > maxEntry) return;
    const prev = this.segmentCache.get(token);
    if (prev) {
      this.segmentCache.delete(token);
      this.segmentCacheBytes = Math.max(0, this.segmentCacheBytes - prev.body.length);
    }
    const now = Date.now();
    for (const [k, v] of this.segmentCache) {
      if (now > v.expiresAt) {
        this.segmentCache.delete(k);
        this.segmentCacheBytes = Math.max(0, this.segmentCacheBytes - v.body.length);
      }
    }
    while (this.segmentCacheBytes + body.length > maxTotal && this.segmentCache.size) {
      const oldestKey = this.segmentCache.keys().next().value;
      const oldest = this.segmentCache.get(oldestKey);
      this.segmentCache.delete(oldestKey);
      if (oldest) this.segmentCacheBytes = Math.max(0, this.segmentCacheBytes - oldest.body.length);
    }
    this.segmentCache.set(token, { body, contentType, expiresAt: now + 30_000 });
    this.segmentCacheBytes += body.length;
  }

  async #handleMovieProxy(req, res, token) {
    const entry = this.remoteStreams.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Stream expired or not found');
      return;
    }
    const cacheableSegment = Boolean(entry.isChildSegment && req.method === 'GET' && !req.headers.range);
    if (cacheableSegment) {
      const cached = this.#getCachedSegment(token);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': cached.contentType,
          'Content-Length': cached.body.length,
          'Cache-Control': 'no-store'
        });
        res.end(cached.body);
        return;
      }
      if (this.inflightSegments.has(token)) {
        const shared = await this.inflightSegments.get(token).catch(() => null);
        if (shared?.body) {
          res.writeHead(200, {
            'Content-Type': shared.contentType,
            'Content-Length': shared.body.length,
            'Cache-Control': 'no-store'
          });
          res.end(shared.body);
          return;
        }
      }
    }
    const upstreamHeaders = {
      ...(entry.headers || {}),
      'User-Agent': entry.headers?.['User-Agent'] || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    };
    if (req.headers.range && !entry.isHls) upstreamHeaders.Range = req.headers.range;
    if (req.headers['if-range'] && !entry.isHls) upstreamHeaders['If-Range'] = req.headers['if-range'];

    if (cacheableSegment) {
      const loader = (async () => {
        const up = await fetch(entry.url, {
          method: 'GET',
          headers: upstreamHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000)
        });
        if (!up.ok) return { status: up.status, headers: {}, body: null };
        const cl = Number(up.headers.get('content-length') || 0);
        if (cl > 12 * 1024 * 1024) {
          return { status: up.status, streamThrough: up, headers: {} };
        }
        const buf = Buffer.from(await up.arrayBuffer());
        const ctypeOut = entry.forceContentType || up.headers.get('content-type') || entry.contentType || 'video/mp2t';
        this.#putCachedSegment(token, buf, ctypeOut);
        return { status: 200, contentType: ctypeOut, body: buf };
      })().finally(() => {
        this.inflightSegments.delete(token);
      });
      this.inflightSegments.set(token, loader);
      try {
        const fetched = await loader;
        if (fetched?.body) {
          res.writeHead(200, {
            'Content-Type': fetched.contentType,
            'Content-Length': fetched.body.length,
            'Cache-Control': 'no-store'
          });
          res.end(fetched.body);
          return;
        }
        if (fetched?.streamThrough) {
          const pass = {};
          for (const h of ['content-type', 'content-length']) {
            const v = fetched.streamThrough.headers.get(h);
            if (v) pass[h] = v;
          }
          if (entry.forceContentType) pass['content-type'] = entry.forceContentType;
          res.writeHead(fetched.status, pass);
          const nodeStream = Readable.fromWeb(fetched.streamThrough.body);
          nodeStream.on('error', () => { try { res.end(); } catch {} });
          res.on('close', () => { try { nodeStream.destroy(); } catch {} });
          nodeStream.pipe(res);
          return;
        }
        res.writeHead(fetched?.status || 502, { 'Content-Type': 'text/plain' });
        res.end('Upstream movie segment unavailable');
        return;
      } catch {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Upstream movie stream unreachable');
        }
        return;
      }
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    let upstream;
    try {
      upstream = await fetch(entry.url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
        signal: controller.signal
      });
    } catch {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Upstream movie stream unreachable');
      }
      return;
    }

    const passHeaders = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const val = upstream.headers.get(h);
      if (val) passHeaders[h] = val;
    }
    const ctype = String(passHeaders['content-type'] || '').toLowerCase();
    if (entry.forceContentType) {
      passHeaders['content-type'] = entry.forceContentType;
    } else if (!passHeaders['content-type'] || entry.isHls) {
      passHeaders['content-type'] = entry.contentType || 'application/octet-stream';
    }

    if (req.method === 'HEAD' || !upstream.body) {
      res.writeHead(upstream.status, passHeaders);
      res.end();
      return;
    }

    const maybePlaylist = upstream.ok
      && !entry.isChildSegment
      && (entry.isHls
        || ctype.includes('mpegurl')
        || ctype.includes('application/json')
        || ctype.includes('text/plain')
        || /\.m3u8(\?|$)/i.test(upstream.url || entry.url));

    if (maybePlaylist) {
      const lenHint = Number(upstream.headers.get('content-length') || 0);
      if (!lenHint || lenHint <= 4 * 1024 * 1024) {
        const rawBuf = Buffer.from(await upstream.arrayBuffer());
        const headSample = rawBuf.subarray(0, 64).toString('utf8').trimStart();
        if (headSample.startsWith('#EXTM3U')) {
          const rewritten = this.#rewriteHlsPlaylist(rawBuf.toString('utf8'), upstream.url || entry.url, entry);
          const outBuf = Buffer.from(rewritten, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Content-Length': outBuf.length,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(outBuf);
          return;
        }
        res.writeHead(upstream.status, passHeaders);
        res.end(rawBuf);
        return;
      }
    }

    res.writeHead(upstream.status, passHeaders);
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.end(); } catch {} });
    res.on('close', () => { try { nodeStream.destroy(); } catch {} });
    nodeStream.pipe(res);
  }

  #serveMediaFile(req, res, filePath, contentType = 'video/mp4', downloadFilename = null) {
    const stat = statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const commonHeaders = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    };

    if (downloadFilename) {
      const safeFn = String(downloadFilename).replace(/[\r\n"']/g, '').trim();
      commonHeaders['Content-Disposition'] = `inline; filename="${safeFn}"`;
    }

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(String(range).trim());
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end();
        return;
      }

      let start;
      let end;
      if (!match[1] && match[2]) {
        // Suffix byte range: bytes=-N (last N bytes)
        const suffixLen = parseInt(match[2], 10);
        start = Math.max(0, fileSize - suffixLen);
        end = fileSize - 1;
      } else {
        start = parseInt(match[1], 10);
        end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;
      }

      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start >= fileSize || start > end) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end();
        return;
      }

      const chunksize = end - start + 1;
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunksize
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = createReadStream(filePath, { start, end });
      stream.on('error', () => { if (!res.headersSent) res.end(); });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        ...commonHeaders,
        'Content-Length': fileSize
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = createReadStream(filePath);
      stream.on('error', () => { if (!res.headersSent) res.end(); });
      stream.pipe(res);
    }
  }
}
