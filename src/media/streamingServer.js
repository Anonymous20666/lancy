import http from 'node:http';
import { existsSync, statSync, createReadStream, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDurationToSeconds } from '../utils/time.js';
import { optimizeVideoForTelegram } from './downloader.js';

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
        if (existsSync(targetPath) && statSync(targetPath).size > 1000) return targetPath;

        // Retrieve metadata from telegram bot controller
        let meta = this.app?.telegram?.controller?.getInlineAudioMetadata?.(trackId)
          || this.app?.telegram?.getInlineAudioMetadata?.(trackId);

        // Fallback: search Deezer by filename if meta is not in memory
        if (!meta && filename) {
          const queryFromFilename = filename.replace(/\.mp3$/i, '').replace(/_/g, ' ').trim();
          if (queryFromFilename) {
            try {
              const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(queryFromFilename)}&limit=1`, { signal: AbortSignal.timeout(3500) }).then((r) => r.json()).catch(() => null);
              const dzItem = dzRes?.data?.[0];
              if (dzItem) {
                meta = {
                  id: dzItem.id,
                  title: dzItem.title,
                  artist: dzItem.artist?.name || 'Music',
                  album: dzItem.album?.title,
                  previewUrl: dzItem.preview
                };
              }
            } catch {}
          }
        }

        let tagged = false;

        // Step 1: If previewUrl is available, fetch and embed clean ID3v2 tags via ffmpeg (<80ms)
        if (meta?.previewUrl) {
          try {
            const res = await fetch(meta.previewUrl, { signal: AbortSignal.timeout(6000) });
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              if (buf.length > 1024) {
                const tempRaw = join(this.audioCacheDir, `temp_raw_${trackId}_${Date.now()}.mp3`);
                writeFileSync(tempRaw, buf);
                try {
                  const titleStr = meta.title || 'Music Track';
                  const artistStr = meta.artist || 'Music';
                  await execFileAsync('ffmpeg', [
                    '-y',
                    '-i', tempRaw,
                    '-metadata', `title=${titleStr}`,
                    '-metadata', `artist=${artistStr}`,
                    ...(meta.album ? ['-metadata', `album=${meta.album}`] : []),
                    '-id3v2_version', '3',
                    '-c', 'copy',
                    targetPath
                  ]);
                  tagged = true;
                } catch (tagErr) {
                  this.log?.debug?.({ err: tagErr?.message, trackId }, 'ffmpeg preview tag failed, using raw');
                  writeFileSync(targetPath, buf);
                  tagged = true;
                } finally {
                  try { unlinkSync(tempRaw); } catch {}
                }
              }
            }
          } catch (fetchErr) {
            this.log?.debug?.({ err: fetchErr?.message, trackId }, 'audio preview fetch failed');
          }
        }

        // Step 2: Trigger full audio track download in the background to ensure user gets full 100% song
        const fullSearchQuery = meta ? `${meta.title} ${meta.artist}`.trim() : (filename ? filename.replace(/\.mp3$/i, '').replace(/_/g, ' ') : '');
        if (fullSearchQuery && fullSearchQuery.length >= 2) {
          (async () => {
            try {
              const downloader = this.app?.mediaDownloader;
              if (downloader) {
                const fullRes = await downloader.download(fullSearchQuery).catch(() => null);
                if (fullRes?.audioTrack?.buffer && fullRes.audioTrack.buffer.length > 10000) {
                  writeFileSync(targetPath, fullRes.audioTrack.buffer);
                  // If a dedicated storage channel is configured, upload to cache permanent file_id (never upload to owner's personal chat)
                  const api = this.app?.telegram?.api;
                  const storageChatId = this.app?.settings?.get('telegram.storageChatId') || this.app?.settings?.get('telegram.storageChannelId');
                  const durSec = fullRes.duration ? parseDurationToSeconds(fullRes.duration) : 0;
                  if (api && storageChatId) {
                    const sent = await api.sendAudio(storageChatId, fullRes.audioTrack.buffer, {
                      title: fullRes.title || meta?.title || fullSearchQuery,
                      performer: fullRes.artist || fullRes.author || meta?.artist || 'Music',
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
                        const songTitle = fullRes.title || meta?.title || fullSearchQuery;
                        const songArtist = fullRes.artist || fullRes.author || meta?.artist || 'Music';
                        const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
                        const cleanQ = fullSearchQuery.toLowerCase().trim();
                        db.run(sql, cleanQ, uploadedFileId, songTitle, songArtist, durSec);
                        if (trackId) db.run(sql, String(trackId), uploadedFileId, songTitle, songArtist, durSec);
                        const cleanT = (songTitle || '').toLowerCase().trim();
                        if (cleanT && cleanT !== cleanQ) {
                          db.run(sql, cleanT, uploadedFileId, songTitle, songArtist, durSec);
                        }
                      }
                    }
                  }
                }
              }
            } catch {}
          })();
        }

        if (tagged && existsSync(targetPath)) {
          return targetPath;
        }

        return existsSync(targetPath) ? targetPath : null;
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
