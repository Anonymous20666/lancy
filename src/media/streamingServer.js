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

const ISO_LANG_ALIAS = {
  jpn: 'ja', jp: 'ja', ja: 'ja', japanese: 'ja',
  eng: 'en', en: 'en', english: 'en',
  spa: 'es', es: 'es', spanish: 'es', espanol: 'es', latino: 'es', castellano: 'es', 'latin american spanish': 'es',
  fre: 'fr', fra: 'fr', fr: 'fr', french: 'fr', francais: 'fr', vf: 'fr', vff: 'fr', vfq: 'fr', truefrench: 'fr',
  ger: 'de', deu: 'de', de: 'de', german: 'de',
  ita: 'it', it: 'it', italian: 'it',
  por: 'pt', pt: 'pt', portuguese: 'pt', portugues: 'pt', brazilian: 'pt', 'brazilian portuguese': 'pt', 'pt-br': 'pt', pt_br: 'pt',
  rus: 'ru', ru: 'ru', russian: 'ru',
  kor: 'ko', ko: 'ko', korean: 'ko',
  chi: 'zh', zho: 'zh', cmn: 'zh', zh: 'zh', chinese: 'zh', mandarin: 'zh', cantonese: 'zh',
  hin: 'hi', hi: 'hi', hindi: 'hi',
  ara: 'ar', ar: 'ar', arabic: 'ar',
  tur: 'tr', tr: 'tr', turkish: 'tr',
  tha: 'th', th: 'th', thai: 'th',
  vie: 'vi', vi: 'vi', vietnamese: 'vi',
  ind: 'id', id: 'id', indonesian: 'id',
  tam: 'ta', ta: 'ta', tamil: 'ta',
  tel: 'te', te: 'te', telugu: 'te',
  mal: 'ml', ml: 'ml', malayalam: 'ml',
  ben: 'bn', bn: 'bn', bengali: 'bn',
  pol: 'pl', pl: 'pl', polish: 'pl',
  ukr: 'uk', uk: 'uk', ukrainian: 'uk',
  nld: 'nl', dut: 'nl', nl: 'nl', dutch: 'nl',
  swe: 'sv', sv: 'sv', swedish: 'sv',
  nor: 'no', nob: 'no', nno: 'no', no: 'no', norwegian: 'no',
  dan: 'da', da: 'da', danish: 'da',
  fin: 'fi', fi: 'fi', finnish: 'fi',
  fil: 'tl', tgl: 'tl', tl: 'tl', tagalog: 'tl', filipino: 'tl',
  per: 'fa', fas: 'fa', fa: 'fa', persian: 'fa',
  heb: 'he', he: 'he', hebrew: 'he',
  und: '', mul: '', zxx: ''
};

export function normalizeLangCode(raw) {
  const cleaned = String(raw || '').trim().toLowerCase();
  if (!cleaned) return '';
  if (ISO_LANG_ALIAS[cleaned] !== undefined) return ISO_LANG_ALIAS[cleaned];
  const primary = cleaned.split(/[-_;\s,()\[\]]/)[0];
  if (ISO_LANG_ALIAS[primary] !== undefined) return ISO_LANG_ALIAS[primary];
  for (const part of cleaned.split(/[-_;\s,()\[\]]+/)) {
    if (part && ISO_LANG_ALIAS[part] !== undefined) return ISO_LANG_ALIAS[part];
  }
  return /^[a-z]{2,3}$/.test(primary) ? primary : '';
}

export function isDubAudioLabel(label = '') {
  return /\b(?:dub(?:s|bed|bing)?|fandub|dublado|doublage|vff|vfq|vf|truefrench|latino|castellano|voice\s*over|voiceover|(?:english|eng|french|fre|fra|spanish|spa|esp|hindi|hin|german|ger|deu|italian|ita|portuguese|por|russian|rus|arabic|ara|turkish|tur|korean|kor|japanese|jpn|chinese|chi|zho|thai|tha|indonesian|ind|vietnamese|vie|polish|pol|dutch|dut|nld)\s*(?:dub(?:s|bed|bing)?|voice\s*over|voiceover|version))\b/i.test(String(label || ''));
}

function classifyMpdResource(absUrl, mimeHint = '', isTextHint = false) {
  let pathname = '';
  let formatParam = '';
  try {
    const parsed = new URL(absUrl);
    pathname = parsed.pathname.toLowerCase();
    formatParam = String(
      parsed.searchParams.get('format')
      || parsed.searchParams.get('fmt')
      || parsed.searchParams.get('type')
      || ''
    ).toLowerCase();
  } catch {
    pathname = String(absUrl || '').split('?')[0].toLowerCase();
  }
  const mime = String(mimeHint || '').toLowerCase();

  if (pathname.endsWith('.vtt') || mime.includes('text/vtt') || formatParam === 'vtt' || formatParam === 'webvtt') {
    return { ext: 'vtt', contentType: 'text/vtt; charset=utf-8', forceContentType: 'text/vtt; charset=utf-8' };
  }
  if (pathname.endsWith('.srt') || mime.includes('subrip') || formatParam === 'srt') {
    return { ext: 'srt', contentType: 'text/plain; charset=utf-8', forceContentType: 'text/plain; charset=utf-8' };
  }
  if (pathname.endsWith('.ttml') || pathname.endsWith('.dfxp') || mime.includes('ttml') || formatParam === 'ttml' || formatParam === 'dfxp') {
    return { ext: 'ttml', contentType: 'application/ttml+xml; charset=utf-8', forceContentType: 'application/ttml+xml; charset=utf-8' };
  }
  if (pathname.endsWith('.ass') || pathname.endsWith('.ssa') || mime.includes('x-ssa') || mime.includes('x-ass')) {
    return { ext: 'ass', contentType: 'text/plain; charset=utf-8', forceContentType: 'text/plain; charset=utf-8' };
  }
  if (isTextHint) {
    return { ext: 'vtt', contentType: null, forceContentType: null };
  }
  if (pathname.endsWith('.m4a') || pathname.endsWith('.aac') || mime.startsWith('audio/')) {
    return { ext: pathname.endsWith('.aac') ? 'aac' : 'm4a', contentType: 'audio/mp4', forceContentType: 'audio/mp4' };
  }
  return { ext: 'mp4', contentType: 'video/mp4', forceContentType: 'video/mp4' };
}

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
    this.activeMainReads = 0;
    this.prestreamQueue = [];
    this.prestreamQueuedTokens = new Set();
    this.inflightPrestream = new Set();

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
    const proxyMatch = pathname.match(/^\/movie-proxy\/([a-f0-9]{16,64})(?:\.(?:m3u8|mpd|ts|mp4|mkv|m4s|m4a|aac|key|vtt|srt|ttml|dfxp|ass|ssa))?$/i);
    if (proxyMatch) {
      const seekSeconds = Math.max(0, parseFloat(parsedUrl.searchParams.get('start') || '0') || 0);
      await this.#handleMovieProxy(req, res, proxyMatch[1], seekSeconds);
      return;
    }

    const proxyBaseMatch = pathname.match(/^\/movie-proxy-base\/([a-f0-9]{16,64})\/(.+)$/i);
    if (proxyBaseMatch) {
      await this.#handleMovieProxyBase(req, res, proxyBaseMatch[1], proxyBaseMatch[2] + (parsedUrl.search || ''));
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

  registerRemoteStream({ url, headers = {}, contentType = 'video/mp4', isHls = false, isDash = false, ttlMs = 8 * 3600 * 1000, maxHeight = 720, videoQuality = null, preferredAudioLang = null, preferH264 = null } = {}) {
    if (!url || !/^https?:\/\//i.test(String(url))) return null;
    const now = Date.now();
    for (const [k, v] of this.remoteStreams) {
      if (now > v.expiresAt) this.remoteStreams.delete(k);
    }
    const token = randomBytes(16).toString('hex');
    const urlStr = String(url);
    const capHeight = Number.isFinite(Number(maxHeight)) && Number(maxHeight) > 0 ? Math.round(Number(maxHeight)) : 720;
    const qualityCap = videoQuality === 'SD_480p' ? 480 : (videoQuality === 'HD_720p' ? 720 : capHeight);
    const effectiveMaxHeight = Math.min(capHeight, qualityCap);
    const prefAudio = normalizeLangCode(preferredAudioLang);
    const shouldPreferH264 = preferH264 !== null ? Boolean(preferH264) : (effectiveMaxHeight <= 720);
    const detectedDash = Boolean(isDash || /dash\+xml/i.test(String(contentType || '')) || /\.mpd(\?|$)/i.test(urlStr));
    const detectedHls = !detectedDash && Boolean(isHls || /mpegurl/i.test(String(contentType || '')) || /\.m3u8(\?|$)/i.test(urlStr));
    this.remoteStreams.set(token, {
      url: urlStr,
      headers: headers && typeof headers === 'object' ? { ...headers } : {},
      contentType: detectedDash ? 'application/dash+xml' : detectedHls ? 'application/vnd.apple.mpegurl' : contentType,
      isHls: detectedHls,
      isDash: detectedDash,
      maxHeight: capHeight,
      effectiveMaxHeight,
      adaptiveMaxHeight: null,
      videoQuality: videoQuality || null,
      rootToken: token,
      measuredBytesPerSec: 0,
      slowFetchStreak: 0,
      selectedVideoBandwidthBps: 0,
      preferredAudioLang: prefAudio,
      preferH264: shouldPreferH264,
      forceContentType: null,
      childTokens: new Map(),
      hlsPlaylistCache: new Map(),
      expiresAt: now + ttlMs
    });
    return `http://127.0.0.1:${this.port}/movie-proxy/${token}${detectedDash ? '.mpd' : detectedHls ? '.m3u8' : ''}`;
  }

  #registerChildProxyStream(parentEntry, targetUrl, { isHls = false, isBasePrefix = false, contentType = 'video/mp2t', forceContentType = null } = {}) {
    const absUrl = String(targetUrl);
    const cacheKey = isBasePrefix ? `base:${absUrl}` : absUrl;
    const existing = parentEntry.childTokens?.get(cacheKey);
    const now = Date.now();
    if (existing) {
      const existingEntry = this.remoteStreams.get(existing);
      if (existingEntry && now <= existingEntry.expiresAt) {
        return existing;
      }
    }
    if (this.remoteStreams.size > 12_000) {
      for (const [k, v] of this.remoteStreams) {
        if (now > v.expiresAt) this.remoteStreams.delete(k);
      }
      if (this.remoteStreams.size > 12_000) {
        for (const [k, v] of this.remoteStreams) {
          if (v.isChildSegment && (now - (v.createdAt || 0) > 180_000)) {
            this.remoteStreams.delete(k);
            if (this.remoteStreams.size <= 6_000) break;
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
      isBasePrefix: Boolean(isBasePrefix),
      maxHeight: parentEntry.maxHeight || 720,
      effectiveMaxHeight: parentEntry.effectiveMaxHeight || parentEntry.maxHeight || 720,
      rootToken: parentEntry.rootToken || null,
      preferredAudioLang: parentEntry.preferredAudioLang || '',
      preferH264: Boolean(parentEntry.preferH264),
      forceContentType,
      isChildSegment: !isHls && !isBasePrefix,
      createdAt: now,
      childTokens: new Map(),
      hlsPlaylistCache: parentEntry.hlsPlaylistCache || new Map(),
      expiresAt: parentEntry.expiresAt
    });
    parentEntry.childTokens?.set(cacheKey, childToken);
    return childToken;
  }

  #selectBestVideoVariant(variants, maxHeight = 720, { preferH264 = false } = {}) {
    if (!Array.isArray(variants) || variants.length <= 1) return variants?.[0] || null;
    const cap = Number.isFinite(Number(maxHeight)) && Number(maxHeight) > 0 ? Number(maxHeight) : 720;
    const withHeight = variants.filter((v) => Number(v.height) > 0);
    if (withHeight.length) {
      const within = withHeight.filter((v) => v.height <= cap);
      let pool = within.length ? within : withHeight;
      if (preferH264) {
        const nonHevc = pool.filter((v) => !v.isHevc && !/h265|hevc/i.test(String(v.uri || '')));
        if (nonHevc.length) pool = nonHevc;
      }
      return pool.reduce((best, cur) => {
        if (!best) return cur;
        if (within.length) {
          if (cur.height !== best.height) return cur.height > best.height ? cur : best;
        } else {
          if (cur.height !== best.height) return cur.height < best.height ? cur : best;
        }
        return (cur.bandwidth || 0) > (best.bandwidth || 0) ? cur : best;
      }, null);
    }
    // Without explicit RESOLUTION/height metadata, prefer moderate bandwidth (<=3.5 Mbps) to avoid 4K decode stalls
    const withBw = variants.filter((v) => Number(v.bandwidth) > 0);
    if (!withBw.length) return variants[0];
    const moderate = withBw.filter((v) => v.bandwidth <= 3_500_000);
    if (moderate.length) {
      return moderate.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
    }
    return withBw.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a));
  }

  #scoreDashAudioSet(attrs, inner, prefLang = '') {
    const langRaw = attrs.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1]
      || inner.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1]
      || '';
    const lang = normalizeLangCode(langRaw);
    const labelText = [
      attrs.match(/\blabel\s*=\s*["']([^"']+)["']/i)?.[1],
      inner.match(/<Label[^>]*>([\s\S]*?)<\/Label>/i)?.[1]
    ].filter(Boolean).join(' ');
    const roles = [...inner.matchAll(/<Role[^>]*\bvalue\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].toLowerCase());
    const isDub = roles.includes('dub') || isDubAudioLabel(labelText);
    const isMain = roles.includes('main') || roles.includes('original');
    const isComment = roles.some((r) => r.includes('commentary') || r.includes('description') || r.includes('alternate'))
      || /\b(?:commentary|descriptive|audio\s*description)\b/i.test(labelText);

    let score = 0;
    if (prefLang && lang) {
      score += (lang === prefLang) ? 100 : -80;
    }
    if (isMain) score += 30;
    if (isDub) score -= 120;
    else score += 30;
    if (isComment) score -= 100;
    return score;
  }

  #pruneMpdVideoRepresentations(xmlText, maxHeight = 720, preferredAudioLang = '') {
    const prefLang = normalizeLangCode(preferredAudioLang);

    const pruneScope = (scopeXml) => {
      const audioSets = [];
      let setIdx = 0;
      const afterVideo = String(scopeXml || '').replace(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi, (full, attrs, inner) => {
        const curIdx = setIdx++;
        const isExplicitText = /\bcontentType\s*=\s*["']text["']/i.test(attrs)
          || /\bmimeType\s*=\s*["'](?:text\/|application\/(?:ttml\+xml|x-subrip))/i.test(`${attrs} ${inner}`);
        const isExplicitAudio = /\bcontentType\s*=\s*["']audio["']/i.test(attrs)
          || (!/\bcontentType\s*=\s*["'](?:video|text)["']/i.test(attrs) && /\bmimeType\s*=\s*["']audio\//i.test(`${attrs} ${inner}`));

        if (isExplicitAudio && !isExplicitText) {
          audioSets.push({ idx: curIdx, score: this.#scoreDashAudioSet(attrs, inner, prefLang) });
          return full;
        }

        const repMatches = [...inner.matchAll(/<Representation\b([^>]*)(?:\/>|>([\s\S]*?)<\/Representation>)/gi)];
        if (repMatches.length <= 1 || isExplicitText) return full;

        const isVideoSet = /\bcontentType\s*=\s*["']video["']/i.test(attrs)
          || repMatches.some((m) => /\bheight\s*=\s*["']\d+["']/i.test(m[1]) || /\bmimeType\s*=\s*["']video\//i.test(m[1]));
        if (!isVideoSet) return full;

        const candidates = repMatches.map((m, idx) => {
          const repAttrs = m[1] || '';
          const hMatch = repAttrs.match(/\bheight\s*=\s*["'](\d+)["']/i);
          const bwMatch = repAttrs.match(/\bbandwidth\s*=\s*["'](\d+)["']/i);
          return {
            idx,
            height: Number(hMatch?.[1] || 0),
            bandwidth: Number(bwMatch?.[1] || 0)
          };
        });
        const winner = this.#selectBestVideoVariant(candidates, maxHeight);
        if (!winner) return full;

        let repIdx = 0;
        const prunedInner = inner.replace(/<Representation\b([^>]*)(?:\/>|>([\s\S]*?)<\/Representation>)\s*/gi, (repBlock) => {
          const keep = repIdx === winner.idx;
          repIdx += 1;
          return keep ? `${repBlock.trimEnd()}\n\t\t\t` : '';
        });
        return `<AdaptationSet${attrs}>${prunedInner}</AdaptationSet>`;
      });

      if (audioSets.length <= 1) return afterVideo;
      const bestAudio = audioSets.reduce((best, cur) => (cur.score > best.score ? cur : best), audioSets[0]);
      // Only strip clearly worse audio AdaptationSets (e.g., dub vs original, wrong language)
      const hasDistinctWinner = audioSets.some((s) => s.idx !== bestAudio.idx && s.score < bestAudio.score);
      if (!hasDistinctWinner) return afterVideo;

      let outIdx = 0;
      return afterVideo.replace(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>\s*/gi, (full) => {
        const curIdx = outIdx++;
        const isAud = audioSets.some((s) => s.idx === curIdx);
        if (isAud && curIdx !== bestAudio.idx) return '';
        return full;
      });
    };

    const src = String(xmlText || '');
    if (/<Period\b/i.test(src)) {
      return src.replace(/<Period\b([^>]*)>([\s\S]*?)<\/Period>/gi, (_, attrs, inner) => `<Period${attrs}>${pruneScope(inner)}</Period>`);
    }
    return pruneScope(src);
  }

  #rewriteMpdManifest(xmlText, baseUrl, parentEntry) {
    const raw = this.#pruneMpdVideoRepresentations(
      String(xmlText || ''),
      parentEntry?.maxHeight || 720,
      parentEntry?.preferredAudioLang || ''
    );
    const decodeXml = (s) => String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const registerBasePrefix = (targetRaw, contextHint = null) => {
      try {
        const abs = new URL(decodeXml(String(targetRaw || '').trim()), baseUrl).toString();
        if (abs.endsWith('/')) {
          const baseTok = this.#registerChildProxyStream(parentEntry, abs, {
            isBasePrefix: true,
            contentType: 'application/octet-stream'
          });
          return `http://127.0.0.1:${this.port}/movie-proxy-base/${baseTok}/`;
        }
        const resInfo = classifyMpdResource(abs, contextHint?.mimeType, contextHint?.isText);
        const singleTok = this.#registerChildProxyStream(parentEntry, abs, {
          isHls: false,
          contentType: resInfo.contentType || 'application/octet-stream',
          forceContentType: resInfo.forceContentType
        });
        return `http://127.0.0.1:${this.port}/movie-proxy/${singleTok}.${resInfo.ext}`;
      } catch {
        return targetRaw;
      }
    };

    let sawBaseUrl = false;
    let out = raw.replace(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi, (full, attrs, inner) => {
      if (!/<BaseURL>/i.test(inner)) return full;
      const mimeType = (
        inner.match(/\bmimeType\s*=\s*["']([^"']+)["']/i)?.[1]
        || attrs.match(/\bmimeType\s*=\s*["']([^"']+)["']/i)?.[1]
        || ''
      );
      const isText = /\bcontentType\s*=\s*["']text["']/i.test(attrs)
        || /\b(?:text\/|ttml|subrip)/i.test(mimeType);
      const updatedInner = inner.replace(/<BaseURL>([\s\S]*?)<\/BaseURL>/gi, (_, baseInner) => {
        sawBaseUrl = true;
        return `<BaseURL>${registerBasePrefix(baseInner, { mimeType, isText })}</BaseURL>`;
      });
      return `<AdaptationSet${attrs}>${updatedInner}</AdaptationSet>`;
    });

    out = out.replace(/<BaseURL>([\s\S]*?)<\/BaseURL>/gi, (_, inner) => {
      sawBaseUrl = true;
      const trimmed = String(inner || '').trim();
      if (/^http:\/\/127\.0\.0\.1:\d+\/movie-proxy(?:-base)?\//.test(trimmed)) {
        return `<BaseURL>${trimmed}</BaseURL>`;
      }
      return `<BaseURL>${registerBasePrefix(inner)}</BaseURL>`;
    });
    if (!sawBaseUrl) {
      try {
        const dirUrl = new URL('./', baseUrl).toString();
        const dirTok = this.#registerChildProxyStream(parentEntry, dirUrl, {
          isBasePrefix: true,
          contentType: 'application/octet-stream'
        });
        const baseTag = `<BaseURL>http://127.0.0.1:${this.port}/movie-proxy-base/${dirTok}/</BaseURL>`;
        out = out.replace(/(<MPD\b[^>]*>)/i, `$1${baseTag}`);
      } catch {}
    }
    return out;
  }

  #sliceHlsMediaLines(lines, targetSeek) {
    if (!(targetSeek > 0.05)) return { lines, skippedSec: 0 };
    const totalSegments = lines.filter((l) => /^#EXTINF\s*:/i.test(l.trim())).length;
    if (totalSegments <= 1) return { lines, skippedSec: 0 };

    const sliced = [];
    let accumSec = 0;
    let skippedCount = 0;
    let skippingDone = false;
    let pendingExtInf = null;
    let pendingSegmentTags = [];
    let mediaSeqIndex = -1;
    let initialMediaSeq = 0;
    let discSeqIndex = -1;
    let initialDiscSeq = 0;
    let skippedDiscontinuities = 0;
    let activeKeyLine = null;
    let activeMapLine = null;
    let firstSegEmitted = false;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const tr = rawLine.trim();
      if (!tr) {
        if (skippingDone || pendingExtInf === null) sliced.push(rawLine);
        continue;
      }
      if (/^#EXT-X-MEDIA-SEQUENCE\s*:\s*(\d+)/i.test(tr)) {
        const m = tr.match(/^#EXT-X-MEDIA-SEQUENCE\s*:\s*(\d+)/i);
        initialMediaSeq = Number(m?.[1] || 0);
        mediaSeqIndex = sliced.length;
        sliced.push(rawLine);
        continue;
      }
      if (/^#EXT-X-DISCONTINUITY-SEQUENCE\s*:\s*(\d+)/i.test(tr)) {
        const m = tr.match(/^#EXT-X-DISCONTINUITY-SEQUENCE\s*:\s*(\d+)/i);
        initialDiscSeq = Number(m?.[1] || 0);
        discSeqIndex = sliced.length;
        sliced.push(rawLine);
        continue;
      }
      if (/^#EXT-X-KEY\b/i.test(tr)) {
        if (!firstSegEmitted) {
          activeKeyLine = rawLine;
        } else {
          sliced.push(rawLine);
        }
        continue;
      }
      if (/^#EXT-X-MAP\b/i.test(tr)) {
        if (!firstSegEmitted) {
          activeMapLine = rawLine;
        } else {
          sliced.push(rawLine);
        }
        continue;
      }
      if (/^#EXT-X-DISCONTINUITY\b/i.test(tr)) {
        if (!firstSegEmitted) {
          skippedDiscontinuities += 1;
        } else {
          sliced.push(rawLine);
        }
        continue;
      }
      const extInfMatch = tr.match(/^#EXTINF\s*:\s*([0-9.]+)/i);
      if (extInfMatch) {
        pendingExtInf = { line: rawLine, dur: parseFloat(extInfMatch[1]) || 0 };
        continue;
      }
      if (tr.startsWith('#')) {
        if (pendingExtInf !== null && /^#EXT-X-(?:BYTERANGE|PROGRAM-DATE-TIME|BITRATE)\b/i.test(tr)) {
          pendingSegmentTags.push(rawLine);
        } else if (!firstSegEmitted && /^#EXT-X-ENDLIST\b/i.test(tr)) {
          sliced.push(rawLine);
        } else {
          sliced.push(rawLine);
        }
        continue;
      }
      if (pendingExtInf !== null) {
        const canSkipMore = (skippedCount < totalSegments - 1);
        if (!skippingDone && canSkipMore && (accumSec + pendingExtInf.dur <= targetSeek + 0.05)) {
          accumSec += pendingExtInf.dur;
          skippedCount += 1;
          pendingExtInf = null;
          pendingSegmentTags = [];
          continue;
        }
        if (!firstSegEmitted) {
          firstSegEmitted = true;
          if (skippedDiscontinuities > 0) {
            if (discSeqIndex >= 0) {
              sliced[discSeqIndex] = `#EXT-X-DISCONTINUITY-SEQUENCE:${initialDiscSeq + skippedDiscontinuities}`;
            } else {
              const insertAt = mediaSeqIndex >= 0 ? mediaSeqIndex + 1 : sliced.length;
              sliced.splice(insertAt, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${skippedDiscontinuities}`);
              if (mediaSeqIndex >= 0 && insertAt <= mediaSeqIndex) mediaSeqIndex += 1;
            }
          }
          if (activeKeyLine) sliced.push(activeKeyLine);
          if (activeMapLine) sliced.push(activeMapLine);
        }
        skippingDone = true;
        sliced.push(pendingExtInf.line);
        for (const tLine of pendingSegmentTags) sliced.push(tLine);
        sliced.push(rawLine);
        pendingExtInf = null;
        pendingSegmentTags = [];
      } else {
        sliced.push(rawLine);
      }
    }
    if (skippedCount > 0 && mediaSeqIndex >= 0) {
      sliced[mediaSeqIndex] = `#EXT-X-MEDIA-SEQUENCE:${initialMediaSeq + skippedCount}`;
    }
    return { lines: sliced, skippedSec: accumSec };
  }

  #scoreHlsAudioTrack(track, prefLang = '') {
    let score = 0;
    if (prefLang && track.lang) {
      score += (track.lang === prefLang) ? 100 : -80;
    }
    if (track.isDub) score -= 120;
    else {
      score += 30;
      if (/\b(?:main|original|orig|raw|native)\b/i.test(track.name || '')) score += 40;
    }
    if (/\b(?:commentary|description|descriptive)\b/i.test(track.name || '')) score -= 100;
    if (track.isDefault) score += 4;
    if (track.isAutoSelect) score += 2;
    return score;
  }

  #pruneHlsMasterLines(lines, maxHeight = 720, preferredAudioLang = '', { preferH264 = false } = {}) {
    const prefLang = normalizeLangCode(preferredAudioLang);
    const audioTracks = [];
    for (let i = 0; i < lines.length; i++) {
      const tr = lines[i].trim();
      if (!/^#EXT-X-MEDIA:\b/i.test(tr) || !/\bTYPE=AUDIO\b/i.test(tr)) continue;
      const groupId = tr.match(/\bGROUP-ID="([^"]+)"/i)?.[1] || '';
      const langRaw = tr.match(/\bLANGUAGE="([^"]+)"/i)?.[1] || '';
      const name = tr.match(/\bNAME="([^"]+)"/i)?.[1] || '';
      const uri = tr.match(/\bURI="([^"]+)"/i)?.[1] || null;
      const isDefault = /\bDEFAULT=YES\b/i.test(tr);
      const isAutoSelect = /\bAUTOSELECT=YES\b/i.test(tr);
      const isDub = isDubAudioLabel(name) || isDubAudioLabel(groupId);
      const track = {
        idx: i,
        line: lines[i],
        groupId,
        lang: normalizeLangCode(langRaw) || normalizeLangCode(name),
        name,
        uri,
        isDefault,
        isAutoSelect,
        isDub
      };
      track.score = this.#scoreHlsAudioTrack(track, prefLang);
      audioTracks.push(track);
    }

    const groupBestScore = new Map();
    for (const a of audioTracks) {
      const prev = groupBestScore.get(a.groupId);
      if (prev === undefined || a.score > prev) groupBestScore.set(a.groupId, a.score);
    }

    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const tr = lines[i].trim();
      if (!/^#EXT-X-STREAM-INF\b/i.test(tr)) continue;
      let uriIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j].trim();
        if (!nxt) continue;
        if (!nxt.startsWith('#')) uriIdx = j;
        break;
      }
      if (uriIdx < 0) continue;
      const resMatch = tr.match(/\bRESOLUTION=(\d+)x(\d+)/i);
      const bwMatch = tr.match(/\b(?:AVERAGE-BANDWIDTH|BANDWIDTH)=(\d+)/i);
      const audioMatch = tr.match(/\bAUDIO="([^"]+)"/i);
      const codecsMatch = tr.match(/\bCODECS="([^"]+)"/i);
      const codecs = codecsMatch?.[1] || '';
      const uriStr = lines[uriIdx].trim();
      const audioGroup = audioMatch?.[1] || null;
      variants.push({
        infIdx: i,
        uriIdx,
        width: Number(resMatch?.[1] || 0),
        height: Number(resMatch?.[2] || 0),
        bandwidth: Number(bwMatch?.[1] || 0),
        codecs,
        isHevc: /\b(?:hvc1|hev1|h265|hevc)\b/i.test(codecs) || /(?:_h265|hevc|x265)/i.test(uriStr),
        audioGroup,
        audioScore: audioGroup && groupBestScore.has(audioGroup) ? groupBestScore.get(audioGroup) : 0,
        uri: uriStr
      });
    }

    let candidateVariants = variants;
    if (variants.length > 1 && audioTracks.length) {
      const maxAudScore = variants.reduce((mx, v) => Math.max(mx, v.audioScore), -Infinity);
      const topAudioPool = variants.filter((v) => v.audioScore >= maxAudScore - 30);
      if (topAudioPool.length) candidateVariants = topAudioPool;
    }

    const winner = candidateVariants.length > 1
      ? this.#selectBestVideoVariant(candidateVariants, maxHeight, { preferH264 })
      : candidateVariants[0] || variants[0] || null;

    const dropIndices = new Set();
    if (variants.length > 1 && winner) {
      for (const v of variants) {
        if (v !== winner) {
          dropIndices.add(v.infIdx);
          dropIndices.add(v.uriIdx);
        }
      }
    }

    const matchingAudio = winner?.audioGroup
      ? audioTracks.filter((a) => !a.groupId || a.groupId === winner.audioGroup)
      : audioTracks;
    const audioPool = matchingAudio.length ? matchingAudio : audioTracks;
    const winningAudio = audioPool.length
      ? audioPool.reduce((best, cur) => (cur.score > best.score ? cur : best), audioPool[0])
      : null;

    const filtered = [];
    let hasSeparateAudio = false;
    let winningAudioUri = null;
    for (let i = 0; i < lines.length; i++) {
      if (dropIndices.has(i)) continue;
      let rawLine = lines[i];
      const tr = rawLine.trim();
      if (/^#EXT-X-MEDIA:\b/i.test(tr)) {
        if (/\bTYPE=SUBTITLES\b/i.test(tr)) continue;
        if (/\bTYPE=AUDIO\b/i.test(tr) && winningAudio) {
          if (i !== winningAudio.idx) continue;
          if (!/\bDEFAULT=YES\b/i.test(rawLine)) {
            if (/\bDEFAULT=\w+/i.test(rawLine)) {
              rawLine = rawLine.replace(/\bDEFAULT=\w+/i, 'DEFAULT=YES');
            } else {
              rawLine = `${rawLine},DEFAULT=YES,AUTOSELECT=YES`;
            }
          }
          if (winningAudio.uri) {
            hasSeparateAudio = true;
            winningAudioUri = winningAudio.uri;
          }
        }
      }
      filtered.push(rawLine);
    }
    return {
      lines: filtered,
      winningVideoUri: winner?.uri || null,
      winningVideoBandwidth: Number(winner?.bandwidth || 0) || 0,
      winningAudioUri,
      hasSeparateAudio
    };
  }

  #cacheVodHlsPlaylist(entry, keyUrl, text, finalUrl) {
    if (!entry?.hlsPlaylistCache || !text) return;
    const isVod = /^#EXT-X-ENDLIST\b/im.test(text) || /^#EXT-X-PLAYLIST-TYPE\s*:\s*VOD\b/im.test(text);
    if (!isVod) return;
    if (entry.hlsPlaylistCache.size > 64) {
      const oldest = entry.hlsPlaylistCache.keys().next().value;
      if (oldest) entry.hlsPlaylistCache.delete(oldest);
    }
    entry.hlsPlaylistCache.set(keyUrl, { text, finalUrl: finalUrl || keyUrl, cachedAt: Date.now() });
  }

  async #fetchHlsPlaylistText(absUrl, parentEntry) {
    let cached = parentEntry?.hlsPlaylistCache?.get(absUrl);
    if (cached && Date.now() - cached.cachedAt <= 30 * 60 * 1000) {
      return cached;
    }
    const up = await fetch(absUrl, {
      method: 'GET',
      headers: {
        ...(parentEntry?.headers || {}),
        'User-Agent': parentEntry?.headers?.['User-Agent'] || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(4000)
    });
    if (!up?.ok) return null;
    const rawText = await up.text();
    if (!rawText || !rawText.trimStart().startsWith('#EXTM3U')) return null;
    const finalUrl = up.url || absUrl;
    this.#cacheVodHlsPlaylist(parentEntry, absUrl, rawText, finalUrl);
    return { text: rawText, finalUrl };
  }

  async #computeAlignedHlsAudioSeek(absVideoUrl, absAudioUrl, parentEntry, targetSeek) {
    try {
      const vidCached = await this.#fetchHlsPlaylistText(absVideoUrl, parentEntry);
      if (!vidCached?.text) return { alignedAudioSeek: null, videoSkippedSec: 0, audioSkippedSec: null, audioTrimDelta: 0 };
      const vidSliced = this.#sliceHlsMediaLines(vidCached.text.split(/\r?\n/), targetSeek);
      const videoSkippedSec = Number(vidSliced.skippedSec || 0);
      let alignedAudioSeek = videoSkippedSec > 0.05 ? Math.max(0, videoSkippedSec - 0.05) : 0;
      let audioSkippedSec = null;

      if (absAudioUrl) {
        try {
          const audCached = await this.#fetchHlsPlaylistText(absAudioUrl, parentEntry);
          if (audCached?.text) {
            const audLines = audCached.text.split(/\r?\n/);
            let audSliced = this.#sliceHlsMediaLines(audLines, alignedAudioSeek);
            // Guarantee audio never starts after video's first kept segment without nuking seek to 0 on >6s segments.
            if (audSliced.skippedSec > videoSkippedSec + 0.005) {
              let bestSeek = alignedAudioSeek;
              let bestSliced = audSliced;
              for (const backSec of [0.25, 1.0, 3.0, 6.0, 12.0, 20.0]) {
                const trySeek = Math.max(0, videoSkippedSec - backSec);
                const trySliced = this.#sliceHlsMediaLines(audLines, trySeek);
                bestSeek = trySeek;
                bestSliced = trySliced;
                if (trySliced.skippedSec <= videoSkippedSec + 0.005 || trySeek <= 0) break;
              }
              alignedAudioSeek = bestSeek;
              audSliced = bestSliced;
            }
            audioSkippedSec = Number(audSliced.skippedSec || 0);
          }
        } catch {}
      }
      const audioTrimDelta = audioSkippedSec != null ? Math.max(0, videoSkippedSec - audioSkippedSec) : 0;
      return { alignedAudioSeek, videoSkippedSec, audioSkippedSec, audioTrimDelta };
    } catch {
      return { alignedAudioSeek: null, videoSkippedSec: 0, audioSkippedSec: null, audioTrimDelta: 0 };
    }
  }

  async #rewriteHlsPlaylist(text, baseUrl, parentEntry, seekSeconds = 0) {
    let lines = String(text || '').split(/\r?\n/);
    const hasInitMap = /^#EXT-X-MAP:/im.test(text);
    const base = `http://127.0.0.1:${this.port}/movie-proxy`;
    const targetSeek = Math.max(0, Number(seekSeconds) || 0);
    const isMaster = /^#EXT-X-STREAM-INF\b/im.test(text);
    let expectVariantPlaylist = false;
    let alignedAudioSeek = null;
    let resolvedSkippedSec = 0;
    let resolvedAudioSkippedSec = null;
    let resolvedAudioTrimDelta = 0;

    if (isMaster) {
      const targetCap = parentEntry?.adaptiveMaxHeight || parentEntry?.effectiveMaxHeight || parentEntry?.maxHeight || 720;
      const pruned = this.#pruneHlsMasterLines(
        lines,
        targetCap,
        parentEntry?.preferredAudioLang || '',
        { preferH264: Boolean(parentEntry?.preferH264 || targetCap <= 720) }
      );
      lines = pruned.lines;
      const rootEntry = parentEntry?.rootToken ? this.remoteStreams.get(parentEntry.rootToken) : parentEntry;
      if (rootEntry && pruned.winningVideoBandwidth > 0) {
        rootEntry.selectedVideoBandwidthBps = pruned.winningVideoBandwidth;
      }
      if (targetSeek > 0.05 && pruned.winningVideoUri) {
        try {
          const absVid = new URL(pruned.winningVideoUri, baseUrl).toString();
          const absAud = pruned.hasSeparateAudio && pruned.winningAudioUri
            ? new URL(pruned.winningAudioUri, baseUrl).toString()
            : null;
          const aligned = await this.#computeAlignedHlsAudioSeek(absVid, absAud, parentEntry, targetSeek);
          resolvedSkippedSec = Number(aligned.videoSkippedSec || 0);
          if (absAud) {
            alignedAudioSeek = aligned.alignedAudioSeek;
            resolvedAudioSkippedSec = aligned.audioSkippedSec;
            resolvedAudioTrimDelta = Number(aligned.audioTrimDelta || 0);
          }
        } catch {}
      }
    } else if (/^#EXTINF\s*:/im.test(text)) {
      if (targetSeek > 0.05) {
        const sliced = this.#sliceHlsMediaLines(lines, targetSeek);
        lines = sliced.lines;
        resolvedSkippedSec = sliced.skippedSec || 0;
      }
    }

    const mediaSegTokens = [];
    const rewriteUri = (rawUri, opts) => {
      try {
        const abs = new URL(rawUri, baseUrl).toString();
        const tok = this.#registerChildProxyStream(parentEntry, abs, opts);
        if (!opts.isHls && (opts.ext === 'ts' || opts.ext === 'm4s')) {
          mediaSegTokens.push(tok);
        }
        const effSeek = (opts.isAudioMedia && alignedAudioSeek !== null) ? alignedAudioSeek : targetSeek;
        const seekSuffix = (opts.ext === 'm3u8' && effSeek > 0.05) ? `?start=${effSeek.toFixed(3)}` : '';
        return `${base}/${tok}.${opts.ext}${seekSuffix}`;
      } catch {
        return rawUri;
      }
    };

    const out = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-MEDIA:\b/i.test(trimmed) && /\bTYPE=SUBTITLES\b/i.test(trimmed)) {
          return null;
        }
        expectVariantPlaylist = /^#EXT-X-STREAM-INF\b/i.test(trimmed);
        if (expectVariantPlaylist) {
          line = line.replace(/,?\s*\bSUBTITLES="[^"]*"/gi, '');
        }
        if (/^#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF)\b/i.test(trimmed) && /\bURI="([^"]+)"/i.test(line)) {
          const isSubPlaylist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)\b/i.test(trimmed);
          const isAudioMedia = /^#EXT-X-MEDIA\b/i.test(trimmed) && /\bTYPE=AUDIO\b/i.test(trimmed);
          const isKey = /^#EXT-X-KEY\b/i.test(trimmed);
          const isMap = /^#EXT-X-MAP\b/i.test(trimmed);
          const opts = isSubPlaylist
            ? { isHls: true, isAudioMedia, contentType: 'application/vnd.apple.mpegurl', forceContentType: 'application/vnd.apple.mpegurl', ext: 'm3u8' }
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
    }).filter((l) => l !== null).join('\n');

    const lookaheadWindow = mediaSegTokens.length >= 12 ? 10 : 2;
    for (let k = 0; k < mediaSegTokens.length; k++) {
      const segEntry = this.remoteStreams.get(mediaSegTokens[k]);
      if (segEntry) segEntry.nextSegmentTokens = mediaSegTokens.slice(k + 1, k + 1 + lookaheadWindow);
    }
    return {
      text: out,
      skippedSec: resolvedSkippedSec,
      audioSkippedSec: resolvedAudioSkippedSec,
      audioTrimDelta: resolvedAudioTrimDelta,
      initialSegTokens: mediaSegTokens.length >= 12 ? mediaSegTokens.slice(0, 4) : []
    };
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
    const maxEntry = 16 * 1024 * 1024;
    const capMb = Math.max(32, Math.min(512, Number(process.env.MOVIE_SEG_CACHE_MB || 96) || 96));
    const maxTotal = capMb * 1024 * 1024;
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
    this.segmentCache.set(token, { body, contentType, expiresAt: now + 240_000 });
    this.segmentCacheBytes += body.length;
  }

  #recordSegmentThroughput(entry, byteLen, elapsedMs) {
    if (!entry || byteLen < 128 * 1024) return;
    const rootEntry = entry.rootToken ? this.remoteStreams.get(entry.rootToken) : entry;
    if (!rootEntry) return;
    const elapsedSec = Math.max(0.05, Number(elapsedMs || 0) / 1000);
    const instBps = byteLen / elapsedSec;
    rootEntry.measuredBytesPerSec = rootEntry.measuredBytesPerSec > 0
      ? (rootEntry.measuredBytesPerSec * 0.65) + (instBps * 0.35)
      : instBps;
    // If 1080p stream downloads slower than its required media bitrate, step adaptive cap down to 720p for smooth playback.
    const capNow = rootEntry.adaptiveMaxHeight || rootEntry.effectiveMaxHeight || rootEntry.maxHeight || 720;
    const reqBytesPerSec = rootEntry.selectedVideoBandwidthBps > 0 ? (rootEntry.selectedVideoBandwidthBps / 8) : 0;
    if (capNow > 720 && reqBytesPerSec > 300_000 && rootEntry.measuredBytesPerSec < reqBytesPerSec * 0.95) {
      rootEntry.slowFetchStreak = (rootEntry.slowFetchStreak || 0) + 1;
      if (rootEntry.slowFetchStreak >= 2) {
        rootEntry.adaptiveMaxHeight = 720;
      }
    } else {
      rootEntry.slowFetchStreak = 0;
    }
  }

  #loadChildSegment(token, entry, upstreamHeaders, { isPrestream = false } = {}) {
    if (this.inflightSegments.has(token)) {
      return this.inflightSegments.get(token);
    }
    const headers = upstreamHeaders || {
      ...(entry.headers || {}),
      'User-Agent': entry.headers?.['User-Agent'] || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    };
    const startedAt = Date.now();
    if (isPrestream) {
      this.inflightPrestream.add(token);
    } else {
      this.activeMainReads += 1;
    }
    const loader = (async () => {
      const up = await fetch(entry.url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000)
      });
      if (!up.ok) return { status: up.status, headers: {}, body: null };
      const cl = Number(up.headers.get('content-length') || 0);
      if (cl > 16 * 1024 * 1024) {
        return { status: up.status, streamThrough: up, headers: {} };
      }
      const buf = Buffer.from(await up.arrayBuffer());
      this.#recordSegmentThroughput(entry, buf.length, Date.now() - startedAt);
      const ctypeOut = entry.forceContentType || up.headers.get('content-type') || entry.contentType || 'video/mp2t';
      this.#putCachedSegment(token, buf, ctypeOut);
      return { status: 200, contentType: ctypeOut, body: buf };
    })().finally(() => {
      this.inflightSegments.delete(token);
      if (isPrestream) {
        this.inflightPrestream.delete(token);
      } else {
        this.activeMainReads = Math.max(0, this.activeMainReads - 1);
      }
      this.#drainPrestreamQueue();
    });
    this.inflightSegments.set(token, loader);
    return loader;
  }

  #drainPrestreamQueue() {
    if (!this.server || !this.prestreamQueue.length) return;
    // Yield completely while an active main-stream segment read is in flight (other than 1 immediate N+1 warm read).
    const maxBg = this.activeMainReads > 0 ? 1 : 3;
    while (this.prestreamQueue.length && this.inflightPrestream.size < maxBg && this.inflightSegments.size < 8) {
      const nextToken = this.prestreamQueue.shift();
      this.prestreamQueuedTokens.delete(nextToken);
      if (!nextToken) continue;
      const nextEntry = this.remoteStreams.get(nextToken);
      if (!nextEntry || !nextEntry.isChildSegment || Date.now() > nextEntry.expiresAt) continue;
      if (this.#getCachedSegment(nextToken) || this.inflightSegments.has(nextToken)) continue;
      void this.#loadChildSegment(nextToken, nextEntry, null, { isPrestream: true }).catch(() => {});
    }
  }

  #scheduleLookaheadPrefetch(entry) {
    if (!this.server || !Array.isArray(entry?.nextSegmentTokens) || !entry.nextSegmentTokens.length) return;
    const now = Date.now();
    // Always prioritize N+1 immediately at the front, and queue N+2..N+10 for idle background pre-stream.
    for (let i = 0; i < entry.nextSegmentTokens.length; i++) {
      const nextToken = entry.nextSegmentTokens[i];
      if (!nextToken) continue;
      const nextEntry = this.remoteStreams.get(nextToken);
      if (!nextEntry || !nextEntry.isChildSegment || now > nextEntry.expiresAt) continue;
      if (this.#getCachedSegment(nextToken) || this.inflightSegments.has(nextToken) || this.prestreamQueuedTokens.has(nextToken)) continue;
      if (i === 0) {
        this.prestreamQueuedTokens.add(nextToken);
        this.prestreamQueue.unshift(nextToken);
      } else {
        this.prestreamQueuedTokens.add(nextToken);
        this.prestreamQueue.push(nextToken);
      }
    }
    this.#drainPrestreamQueue();
  }

  async #sendRewrittenHls(res, rawText, baseUrl, entry, seekSeconds) {
    const rewritten = await this.#rewriteHlsPlaylist(rawText, baseUrl, entry, seekSeconds);
    const outBuf = Buffer.from(rewritten.text, 'utf8');
    const hdrs = {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': outBuf.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    };
    if (seekSeconds > 0.05 && Number.isFinite(rewritten.skippedSec) && rewritten.skippedSec > 0) {
      hdrs['X-Lancy-Skipped-Sec'] = Number(rewritten.skippedSec).toFixed(3);
    }
    if (seekSeconds > 0.05 && Number.isFinite(rewritten.audioSkippedSec) && rewritten.audioSkippedSec >= 0) {
      hdrs['X-Lancy-Audio-Skipped-Sec'] = Number(rewritten.audioSkippedSec).toFixed(3);
    }
    if (seekSeconds > 0.05 && Number.isFinite(rewritten.audioTrimDelta) && rewritten.audioTrimDelta > 0) {
      hdrs['X-Lancy-Audio-Trim-Delta'] = Number(rewritten.audioTrimDelta).toFixed(3);
    }
    res.writeHead(200, hdrs);
    res.end(outBuf);
    if (Array.isArray(rewritten.initialSegTokens) && rewritten.initialSegTokens.length) {
      this.#scheduleLookaheadPrefetch({ nextSegmentTokens: rewritten.initialSegTokens });
    }
  }

  async #handleMovieProxy(req, res, token, seekSeconds = 0) {
    const entry = this.remoteStreams.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Stream expired or not found');
      return;
    }
    if (entry.isHls && req.method === 'GET' && entry.hlsPlaylistCache?.has(entry.url)) {
      const cachedPls = entry.hlsPlaylistCache.get(entry.url);
      if (cachedPls && Date.now() - cachedPls.cachedAt < 30 * 60 * 1000) {
        await this.#sendRewrittenHls(res, cachedPls.text, cachedPls.finalUrl || entry.url, entry, seekSeconds);
        return;
      }
    }
    const cacheableSegment = Boolean(entry.isChildSegment && req.method === 'GET' && !req.headers.range);
    if (cacheableSegment) {
      const cached = this.#getCachedSegment(token);
      if (cached) {
        this.#scheduleLookaheadPrefetch(entry);
        res.writeHead(200, {
          'Content-Type': cached.contentType,
          'Content-Length': cached.body.length,
          'Cache-Control': 'no-store'
        });
        res.end(cached.body);
        return;
      }
      if (this.inflightSegments.has(token)) {
        this.#scheduleLookaheadPrefetch(entry);
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
      const loader = this.#loadChildSegment(token, entry, upstreamHeaders);
      this.#scheduleLookaheadPrefetch(entry);
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

    const maybeDash = upstream.ok
      && !entry.isChildSegment
      && (entry.isDash
        || ctype.includes('dash+xml')
        || /\.mpd(\?|$)/i.test(upstream.url || entry.url));

    if (maybePlaylist || maybeDash) {
      const lenHint = Number(upstream.headers.get('content-length') || 0);
      if (!lenHint || lenHint <= 8 * 1024 * 1024) {
        let rawBuf;
        try {
          rawBuf = Buffer.from(await upstream.arrayBuffer());
        } catch {
          if (!res.headersSent) {
            try { res.writeHead(499, { 'Content-Type': 'text/plain' }); res.end(); } catch {}
          }
          return;
        }
        const headSample = rawBuf.subarray(0, 512).toString('utf8').trimStart();
        if (headSample.startsWith('#EXTM3U')) {
          const rawText = rawBuf.toString('utf8');
          const finalUrl = upstream.url || entry.url;
          this.#cacheVodHlsPlaylist(entry, entry.url, rawText, finalUrl);
          await this.#sendRewrittenHls(res, rawText, finalUrl, entry, seekSeconds);
          return;
        }
        if (maybeDash && /<MPD\b/i.test(headSample)) {
          const rewritten = this.#rewriteMpdManifest(rawBuf.toString('utf8'), upstream.url || entry.url, entry);
          const outBuf = Buffer.from(rewritten, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/dash+xml',
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

  async #handleMovieProxyBase(req, res, baseToken, relPath) {
    const baseEntry = this.remoteStreams.get(baseToken);
    if (!baseEntry || !baseEntry.isBasePrefix || Date.now() > baseEntry.expiresAt) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Stream base expired or not found');
      return;
    }
    const cleanRel = String(relPath || '').replace(/^\/+/, '');
    if (!cleanRel || cleanRel.split('/').some((seg) => seg === '..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden path');
      return;
    }
    let targetUrl;
    try {
      targetUrl = new URL(cleanRel, baseEntry.url).toString();
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid segment path');
      return;
    }

    const cacheKey = `dash:${baseToken}:${cleanRel}`;
    const cacheableSegment = req.method === 'GET' && !req.headers.range;
    if (cacheableSegment) {
      const cached = this.#getCachedSegment(cacheKey);
      if (cached) {
        res.writeHead(200, {
          'Content-Type': cached.contentType,
          'Content-Length': cached.body.length,
          'Cache-Control': 'no-store'
        });
        res.end(cached.body);
        return;
      }
      if (this.inflightSegments.has(cacheKey)) {
        const shared = await this.inflightSegments.get(cacheKey).catch(() => null);
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
      ...(baseEntry.headers || {}),
      'User-Agent': baseEntry.headers?.['User-Agent'] || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    };
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;
    if (req.headers['if-range']) upstreamHeaders['If-Range'] = req.headers['if-range'];

    if (cacheableSegment) {
      const loader = (async () => {
        const up = await fetch(targetUrl, {
          method: 'GET',
          headers: upstreamHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000)
        });
        if (!up.ok) return { status: up.status, body: null };
        const cl = Number(up.headers.get('content-length') || 0);
        if (cl > 12 * 1024 * 1024) return { status: up.status, streamThrough: up };
        const buf = Buffer.from(await up.arrayBuffer());
        const ctypeOut = up.headers.get('content-type') || 'video/mp4';
        this.#putCachedSegment(cacheKey, buf, ctypeOut);
        return { status: 200, contentType: ctypeOut, body: buf };
      })().finally(() => {
        this.inflightSegments.delete(cacheKey);
      });
      this.inflightSegments.set(cacheKey, loader);
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
          res.writeHead(fetched.status, pass);
          const nodeStream = Readable.fromWeb(fetched.streamThrough.body);
          nodeStream.on('error', () => { try { res.end(); } catch {} });
          res.on('close', () => { try { nodeStream.destroy(); } catch {} });
          nodeStream.pipe(res);
          return;
        }
        res.writeHead(fetched?.status || 502, { 'Content-Type': 'text/plain' });
        res.end('Upstream DASH segment unavailable');
        return;
      } catch {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Upstream DASH segment unreachable');
        }
        return;
      }
    }

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const upstream = await fetch(targetUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
        signal: controller.signal
      });
      const pass = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const val = upstream.headers.get(h);
        if (val) pass[h] = val;
      }
      res.writeHead(upstream.status, pass);
      if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
      }
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', () => { try { res.end(); } catch {} });
      res.on('close', () => { try { nodeStream.destroy(); } catch {} });
      nodeStream.pipe(res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Upstream DASH segment unreachable');
      }
    }
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
