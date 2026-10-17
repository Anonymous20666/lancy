import http from 'node:http';
import { existsSync, statSync, createReadStream, writeFileSync, unlinkSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDurationToSeconds } from '../utils/time.js';
import { optimizeVideoForTelegram, getCookieArgs, getAudioDurationSeconds } from './downloader.js';
import { resolveAndDownloadAudio } from './musicResolver.js';

const execFileAsync = promisify(execFile);

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
        this.log?.info?.({ port: this.port }, 'video streaming server listening on 127.0.0.1');
        resolve(this.server);
      });
    });
  }

  async stop() {
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

    // 1. Audio stream request (/audio/:id/:filename? or /audio/live/:id/:filename?)
    const audioMatch = pathname.match(/^\/audio\/(?:live\/)?([a-zA-Z0-9_-]+)(?:\/([^\/]+))?$/i);
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
        const tempPath = join(this.audioCacheDir, `temp_full_${trackId}_${Date.now()}.mp3`);

        // Multi-source full-track resolution (YouTube exact-id -> Audius full
        // stream), duration-validated >= 45s so previews can never leak through.
        let downloaded = false;
        try {
          const resolved = await resolveAndDownloadAudio({
            query: searchQuery,
            trackId: isYouTubeId ? trackId : null,
            tempPath,
            minSeconds: 45,
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
              ...cookieArgs,
              '-N', '4',
              '--max-filesize', '50M',
              '--js-runtimes', 'node:/usr/bin/node',
              '-f', 'ba/b',
              '-x',
              '--audio-format', 'mp3',
              '--audio-quality', '2',
              '-o', tempPath,
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
            await execFileAsync('ffmpeg', [
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
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
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
