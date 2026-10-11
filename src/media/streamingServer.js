import http from 'node:http';
import { existsSync, statSync, createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDurationToSeconds } from '../utils/time.js';
import { optimizeVideoForTelegram } from './downloader.js';

/**
 * High-Performance Video Streaming Server for Telegram Bot API
 * Listens on 127.0.0.1:3055 and dynamically streams H.264/AAC faststart MP4 videos
 * with full HTTP Range (206 Partial Content) support.
 */
export class VideoStreamingServer {
  constructor({ app, port = 3055, cacheDir = '/data/video_cache', log } = {}) {
    this.app = app;
    this.port = port;
    this.cacheDir = cacheDir;
    this.log = log || app?.log;
    this.server = null;
    this.activeDownloads = new Map();

    try {
      mkdirSync(this.cacheDir, { recursive: true });
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

    this.#serveVideoFile(req, res, filePath);
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

          // Upload to Telegram in background and cache file_id
          const api = this.app?.telegram?.api;
          const ownerId = (this.app?.settings?.get('telegram.ownerIds') || [])[0] || 8380969639;
          const durSec = res.duration ? parseDurationToSeconds(res.duration) : 30;

          if (api) {
            (async () => {
              try {
                const sent = await api.sendVideo(ownerId, finalBuffer, {
                  caption: `🎬 ${res.title || 'Clip'}`,
                  duration: durSec > 0 ? durSec : 30,
                  supports_streaming: true,
                  disable_notification: true
                });
                const fileId = sent?.video?.file_id;
                if (fileId) {
                  if (sent.message_id) {
                    await api.call('deleteMessage', { chat_id: ownerId, message_id: sent.message_id }).catch(() => {});
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

  #serveVideoFile(req, res, filePath) {
    const stat = statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const commonHeaders = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    };

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
