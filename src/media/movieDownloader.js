import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { uploadLimitBytes, planVideoFit, DOWNLOAD_QUALITY_PROFILES, normalizeDownloadQuality } from './telegramLimits.js';
import { RichMessageBuilder, block, rt, richButton } from '../telegram/rich.js';
import { escapeHtml } from '../telegram/rich.js';
import { ProgressTracker } from '../telegram/progress.js';
import { durationText } from '../music/model.js';
import { logger } from '../core/logger.js';
import { normalizeLangCode, isDubAudioLabel } from './streamingServer.js';
import { parseAnySubtitleText, serializeSrt } from './subtitles.js';

const execFileAsync = promisify(execFile);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_AUDIO_KBPS = 96;
const MP4_UNIVERSAL_AUDIO_CODECS = new Set(['aac', 'mp3']);

function sanitizeFilename(raw, fallback = 'lancy_movie') {
  const clean = String(raw || fallback)
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64)
    .replace(/^[_\.]+|[_\.]+$/g, '');
  return clean || fallback;
}

function buildFfmpegHeaders(headers = {}) {
  const merged = { 'User-Agent': UA, ...(headers || {}) };
  return Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('\r\n') + '\r\n';
}

async function probeDurationSeconds(filePath, runner = execFileAsync) {
  try {
    const { stdout } = await runner('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 20000 });
    const d = parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

async function probeVideoHeight(filePath, runner = execFileAsync) {
  try {
    const { stdout } = await runner('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=height',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 20000 });
    const h = parseInt(String(stdout).trim(), 10);
    return Number.isFinite(h) && h > 0 ? h : null;
  } catch {
    return null;
  }
}

function escapeFfmpegFilterPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Collapse noisy internal tier-scanning resolver messages into clean user milestones. */
export function sanitizeDownloadProgress(line) {
  const txt = String(line || '').trim();
  if (!txt) return '';
  if (/^[\u{1F4AC}\u{1F501}\u{1F50E}\u{1F3AC}\u{1F51E}\u{23F3}\u{2705}\u{26A0}\u{2139}\u{FE0F}\s]*\[(?:\d+(?:\.\d+)?\/\d+|Subs|5\.5)\]/u.test(txt)) {
    if (/\[Subs\]/i.test(txt)) return '💬 Checking subtitles…';
    return '🔎 Finding best HD mirror with audio…';
  }
  return txt;
}

/**
 * Single-pass ffprobe inspection returning stream topology (video, audio, subtitles, duration, height).
 * Only sets `known: true` when ffprobe yields valid JSON with a non-empty streams array.
 */
export async function probeMediaFile(inputTarget, runner = execFileAsync, { headers = null, timeoutMs = 20000 } = {}) {
  const empty = {
    known: false,
    durationSeconds: null,
    height: null,
    width: null,
    videoCodec: null,
    hasVideo: true,
    hasAudio: true,
    audioStreams: [],
    subtitleStreams: []
  };
  try {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams'];
    if (headers && /^https?:\/\//i.test(String(inputTarget || ''))) {
      args.push('-headers', buildFfmpegHeaders(headers));
    }
    args.push(String(inputTarget || ''));
    const { stdout } = await runner('ffprobe', args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    const raw = String(stdout || '').trim();
    if (!raw.startsWith('{')) return empty;
    const parsed = JSON.parse(raw);
    const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    if (!streams.length) return empty;
    const videoStreams = streams.filter((s) => s?.codec_type === 'video' && !s?.disposition?.attached_pic);
    const rawAudioStreams = streams.filter((s) => s?.codec_type === 'audio');
    const rawSubStreams = streams.filter((s) => s?.codec_type === 'subtitle');
    const firstV = videoStreams[0] || streams.find((s) => s?.codec_type === 'video') || null;
    const fmtDur = parseFloat(parsed?.format?.duration);
    const streamDur = parseFloat(firstV?.duration);
    const durationSeconds = (Number.isFinite(fmtDur) && fmtDur > 0)
      ? fmtDur
      : ((Number.isFinite(streamDur) && streamDur > 0) ? streamDur : null);
    const h = parseInt(firstV?.height, 10);
    const w = parseInt(firstV?.width, 10);
    const audioStreams = rawAudioStreams.map((s, idx) => {
      const lang = normalizeLangCode(s?.tags?.language || s?.tags?.lang || '');
      const titleTag = [s?.tags?.title, s?.tags?.handler_name].filter(Boolean).join(' ');
      const disp = s?.disposition || {};
      return {
        streamPos: idx,
        codec: String(s?.codec_name || '').toLowerCase(),
        channels: Number(s?.channels || 0) || 0,
        language: lang,
        title: titleTag,
        isDub: Boolean(disp.dub || isDubAudioLabel(titleTag)),
        isCommentary: Boolean(disp.commentary || /\b(?:commentary|description|descriptive)\b/i.test(titleTag)),
        isOriginal: Boolean(disp.original || /\b(?:main|original|orig|raw|native)\b/i.test(titleTag)),
        isDefault: Boolean(disp.default)
      };
    });
    const subtitleStreams = rawSubStreams.map((s, idx) => ({
      streamPos: idx,
      codec: String(s?.codec_name || '').toLowerCase(),
      language: normalizeLangCode(s?.tags?.language || s?.tags?.lang || ''),
      title: [s?.tags?.title, s?.tags?.handler_name].filter(Boolean).join(' ')
    }));
    return {
      known: true,
      durationSeconds,
      height: Number.isFinite(h) && h > 0 ? h : null,
      width: Number.isFinite(w) && w > 0 ? w : null,
      videoCodec: firstV?.codec_name ? String(firstV.codec_name).toLowerCase() : null,
      hasVideo: Boolean(videoStreams.length > 0 || firstV),
      hasAudio: audioStreams.length > 0,
      audioStreams,
      subtitleStreams
    };
  } catch {
    return empty;
  }
}

/** Pick best non-dub audio stream index matching preferred original language. */
export function pickBestAudioStream(audioStreams = [], preferredAudioLang = '') {
  if (!Array.isArray(audioStreams) || !audioStreams.length) {
    return { bestIndex: 0, stream: null, isDub: false };
  }
  const prefLang = normalizeLangCode(preferredAudioLang);
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < audioStreams.length; i += 1) {
    const s = audioStreams[i];
    let score = 0;
    if (prefLang && s.language) score += (s.language === prefLang) ? 100 : -80;
    if (s.isDub) score -= 120;
    else {
      score += 30;
      if (s.isOriginal) score += 40;
    }
    if (s.isCommentary) score -= 100;
    if (s.isDefault) score += 4;
    if (MP4_UNIVERSAL_AUDIO_CODECS.has(s.codec)) score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return {
    bestIndex,
    stream: audioStreams[bestIndex] || audioStreams[0],
    isDub: Boolean(audioStreams[bestIndex]?.isDub || (prefLang && audioStreams[bestIndex]?.language && audioStreams[bestIndex].language !== prefLang))
  };
}

/** Order candidate mirrors so non-dubbed original-language sources are tried first. */
export function sortDownloadCandidates(candidates = [], preferredOriginalLang = '') {
  const pref = normalizeLangCode(preferredOriginalLang);
  return candidates
    .map((c, idx) => {
      const cLang = normalizeLangCode(c?.audioLanguage || c?.preferredAudioLang || '');
      const isDub = Boolean(c?.audioIsDub || (pref && cLang && cLang !== pref));
      let score = 0;
      if (!isDub) score += 100;
      if (pref && cLang === pref) score += 50;
      const fmt = String(c?.format || '').toLowerCase();
      if (fmt === 'mp4') score += 10;
      if (c?.audioUrl || c?.separateAudioUrl) score += 5;
      return { c, idx, score };
    })
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map((x) => x.c);
}

/** Validate subtitle timing/length & language sanity, converting to clean UTF-8 .srt when valid. */
export function validateAndPrepareSrt(subPath, workDir, { durationSeconds = null, expectEnglish = true } = {}) {
  if (!subPath || !existsSync(subPath)) return { ok: false, reason: 'missing' };
  try {
    const raw = readFileSync(subPath, 'utf8');
    if (!raw || raw.trim().length < 80) return { ok: false, reason: 'empty' };
    const ext = String(subPath).split('.').pop()?.toLowerCase() || '';
    const cues = parseAnySubtitleText(raw, ext);
    if (!Array.isArray(cues) || cues.length < 12) return { ok: false, reason: 'too_few_cues' };
    const lastEndSec = Math.max(...cues.map((c) => Number(c.endMs || 0))) / 1000;
    const dur = Number(durationSeconds || 0);
    if (dur >= 300) {
      if (lastEndSec < Math.max(90, dur * 0.22)) return { ok: false, reason: 'trailer_or_truncated_subs' };
      if (lastEndSec > (dur * 1.4) + 120) return { ok: false, reason: 'mismatched_duration_subs' };
    }
    if (expectEnglish) {
      const sampleText = cues.slice(0, 60).map((c) => String(c.text || '')).join(' ');
      const latinChars = (sampleText.match(/[A-Za-z]/g) || []).length;
      const nonAsciiLetters = (sampleText.match(/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
      if (nonAsciiLetters > latinChars && nonAsciiLetters > 40) {
        return { ok: false, reason: 'non_english_sub_track' };
      }
    }
    const cleanSrt = serializeSrt(cues);
    const outSrt = join(workDir, `verified_subs_${randomBytes(2).toString('hex')}.srt`);
    writeFileSync(outSrt, cleanSrt, 'utf8');
    return { ok: true, srtPath: outSrt, cueCount: cues.length };
  } catch {
    return { ok: false, reason: 'parse_error' };
  }
}

export async function selectOriginalAudioMapArgs(inputTarget, runner = execFileAsync, { headers = null, preferredAudioLang = '' } = {}) {
  try {
    const args = ['-v', 'quiet', '-print_format', 'json', '-select_streams', 'a', '-show_streams'];
    if (headers && /^https?:\/\//i.test(String(inputTarget || ''))) {
      args.push('-headers', buildFfmpegHeaders(headers));
    }
    args.push(String(inputTarget || ''));
    const { stdout } = await runner('ffprobe', args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout || '{}');
    const rawStreams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    if (rawStreams.length <= 1) return [];
    const normalized = rawStreams.map((s, idx) => {
      const lang = normalizeLangCode(s?.tags?.language || s?.tags?.lang || '');
      const titleTag = [s?.tags?.title, s?.tags?.handler_name].filter(Boolean).join(' ');
      const disp = s?.disposition || {};
      return {
        streamPos: idx,
        codec: String(s?.codec_name || '').toLowerCase(),
        language: lang,
        title: titleTag,
        isDub: Boolean(disp.dub || isDubAudioLabel(titleTag)),
        isCommentary: Boolean(disp.commentary || /\b(?:commentary|description|descriptive)\b/i.test(titleTag)),
        isOriginal: Boolean(disp.original || /\b(?:main|original|orig|raw|native)\b/i.test(titleTag)),
        isDefault: Boolean(disp.default)
      };
    });
    const { bestIndex } = pickBestAudioStream(normalized, preferredAudioLang);
    return ['-map', '0:v:0', '-map', `0:a:${bestIndex}`];
  } catch {
    return [];
  }
}

/**
 * Movie & TV Episode disk downloader + Telegram Local Bot API (up to 2 GB)
 * fitter + Bot API 10.3 paginated album slide publisher.
 */
export class MovieDownloader {
  constructor({ app, cacheDir = null, log = null, fetchImpl = fetch, runner = execFileAsync } = {}) {
    this.app = app;
    this.cacheDir = cacheDir || join(app?.root || process.cwd(), 'cache', 'movie_dl');
    this.log = log || logger().child({ module: 'movie-downloader' });
    this.fetch = fetchImpl;
    this.runner = runner;
    this.fileIdCache = new Map();
    try { mkdirSync(this.cacheDir, { recursive: true }); } catch {}
  }

  getLimitBytes() {
    return uploadLimitBytes();
  }

  #cacheKey(item, limitBytes = this.getLimitBytes(), quality = null) {
    const id = item?.id ?? item?.tmdbId ?? item?.providerId ?? null;
    if (!id) return null;
    const type = String(
      item.type || (item.isAdult ? (item.sourceKey || 'adult') : (item.episode != null || item.episodeNumber != null ? 'tv' : 'movie'))
    ).toLowerCase();
    const s = Number(item.season ?? item.seasonNumber ?? 0) || 0;
    const e = Number(item.episode ?? item.episodeNumber ?? 0) || 0;
    const tier = limitBytes >= 500 * 1024 * 1024 ? '2g' : '50m';
    if (quality != null && quality !== '') {
      return `mv:${type}:${id}:${s}:${e}:${tier}:q${normalizeDownloadQuality(quality)}`;
    }
    return `mv:${type}:${id}:${s}:${e}:${tier}`;
  }

  #lookupCachedFileId(key) {
    if (!key) return null;
    const mem = this.fileIdCache.get(key);
    if (mem?.file_id) return mem;
    try {
      const row = this.app?.db?.get?.(
        'SELECT file_id, title, duration FROM cached_video_tracks WHERE query = ? ORDER BY id DESC LIMIT 1',
        key
      );
      if (row?.file_id) {
        const entry = { file_id: String(row.file_id), title: row.title || null, duration: Number(row.duration || 0) || null };
        this.fileIdCache.set(key, entry);
        return entry;
      }
    } catch {}
    return null;
  }

  #saveCachedFileId(key, fileId, title = 'Movie', durationSeconds = null) {
    if (!key || !fileId) return;
    const cleanId = String(fileId).trim();
    if (!cleanId) return;
    const dur = durationSeconds ? Math.round(Number(durationSeconds)) : null;
    if (this.fileIdCache.size >= 500) {
      const oldest = this.fileIdCache.keys().next().value;
      if (oldest) this.fileIdCache.delete(oldest);
    }
    this.fileIdCache.set(key, { file_id: cleanId, title: String(title || 'Movie'), duration: dur });
    try {
      this.app?.db?.run?.('DELETE FROM cached_video_tracks WHERE query = ?', key);
      this.app?.db?.run?.(
        'INSERT INTO cached_video_tracks (query, file_id, title, duration) VALUES (?, ?, ?, ?)',
        key,
        cleanId,
        String(title || 'Movie').slice(0, 180),
        dur
      );
    } catch {}
  }

  #extractFileId(msg) {
    if (!msg || typeof msg !== 'object') return null;
    return msg.video?.file_id || msg.document?.file_id || msg.animation?.file_id || null;
  }

  hasCachedVideo(item, quality = null) {
    const limitBytes = this.getLimitBytes();
    if (quality != null && quality !== '') {
      const key = this.#cacheKey(item, limitBytes, normalizeDownloadQuality(quality));
      return Boolean(this.#lookupCachedFileId(key)?.file_id);
    }
    const legacy = this.#cacheKey(item, limitBytes, null);
    if (this.#lookupCachedFileId(legacy)?.file_id) return true;
    for (const q of ['480p', '360p', '720p']) {
      if (this.#lookupCachedFileId(this.#cacheKey(item, limitBytes, q))?.file_id) return true;
    }
    return false;
  }

  /**
   * Resolve and materialize a single movie, TV episode, or already-playing track into an .mp4 on disk.
   * Caller must invoke `cleanup()` when upload finishes.
   */
  async prepareVideoFile(item, { onProgress = null, skipCache = false, quality = '480p', allowAdultFeatures = false, subtitles = null } = {}) {
    let lastEmitAt = 0;
    let lastEmitLine = '';
    const emit = (msg, { sanitize = false, force = false } = {}) => {
      if (typeof onProgress !== 'function') return;
      const line = sanitize ? sanitizeDownloadProgress(msg) : String(msg || '').trim();
      if (!line) return;
      const now = Date.now();
      if (!force && line === lastEmitLine) return;
      if (!force && (now - lastEmitAt) < 1200) return;
      lastEmitAt = now;
      lastEmitLine = line;
      void onProgress(line);
    };
    const emitCleanResolver = (msg) => emit(msg, { sanitize: true });
    const limitBytes = this.getLimitBytes();
    const targetQuality = normalizeDownloadQuality(quality);
    const profile = DOWNLOAD_QUALITY_PROFILES[targetQuality] || DOWNLOAD_QUALITY_PROFILES['480p'];
    const cacheKey = !skipCache && !item?.filePath ? this.#cacheKey(item, limitBytes, targetQuality) : null;
    if (cacheKey) {
      const cached = this.#lookupCachedFileId(cacheKey);
      if (cached?.file_id) {
        const displayTitle = item?.title || cached.title || 'Movie';
        emit(`⚡ Instant ${profile.short} cache hit for ${displayTitle}!`, { force: true });
        return {
          ok: true,
          cachedFileId: cached.file_id,
          quality: targetQuality,
          cacheKey,
          filePath: null,
          filename: `${sanitizeFilename(displayTitle, 'movie')}_${profile.short}.mp4`,
          sizeBytes: 0,
          durationSeconds: Number(item?.durationSeconds || cached.duration || 0) || null,
          title: displayTitle,
          track: item,
          cleanup: () => {}
        };
      }
    }
    const workDir = join(this.cacheDir, `${Date.now()}_${randomBytes(3).toString('hex')}`);
    mkdirSync(workDir, { recursive: true });

    const cleanup = () => {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    };

    try {
      const expectedOrigLang = normalizeLangCode(item?.originalLanguage || item?.language || '');
      const initialNeedSubs = Boolean(
        subtitles === true
        || item?.includeSubtitles
        || (expectedOrigLang && expectedOrigLang !== 'en' && expectedOrigLang !== 'und')
      );
      let track = item?.streamUrl || item?.videoUrl || item?.filePath ? item : null;
      let resolvedSubInfo = null;
      if (!track && item?.isAdult && item?.pageUrl && typeof this.app?.adultCatalog?.resolveStream === 'function') {
        emit(`🔎 Finding ${profile.short} 18+ stream for ${item?.title || 'video'}…`, { force: true });
        const resolvedAdult = await this.app.adultCatalog.resolveStream(item, {
          preferredHeight: profile.height
        }).catch(() => null);
        if (resolvedAdult?.streamUrl) {
          track = {
            ...item,
            streamUrl: resolvedAdult.streamUrl,
            videoUrl: resolvedAdult.streamUrl,
            isHls: Boolean(resolvedAdult.isHls),
            variants: resolvedAdult.variants || item.variants || null,
            streamHeaders: { ...(item.streamHeaders || item.headers || {}), ...(resolvedAdult.headers || {}) },
            durationSeconds: resolvedAdult.durationSeconds || item.durationSeconds || null
          };
        }
      }
      if (!track && this.app?.movieResolver) {
        emit(`🔎 Finding verified ${profile.short} stream for ${item?.title || 'title'}…`, { force: true });
        const res = await this.app.movieResolver.resolve(item, {
          fetchSubtitles: initialNeedSubs,
          preferredHeight: profile.height,
          originalLanguage: expectedOrigLang || null,
          allowAdultFeatures: Boolean(allowAdultFeatures),
          onProgress: emitCleanResolver
        });
        if (!res?.ok || !res.track) {
          return { ok: false, reason: res?.reason || 'No downloadable stream found for this title.', cleanup };
        }
        track = res.track;
        resolvedSubInfo = res.subtitles || null;
      }
      if (!track) {
        return { ok: false, reason: 'No stream metadata available to download.', cleanup };
      }

      const displayTitle = track.title || item?.title || 'Movie';
      const safeName = sanitizeFilename(displayTitle, 'movie');
      const effectiveOrigLang = expectedOrigLang || normalizeLangCode(track.originalLanguage || track.preferredAudioLang || '');
      let outPath = join(workDir, `${safeName}.mp4`);
      let dlProbe = null;
      let activeCand = track;

      if (track.filePath && existsSync(track.filePath)) {
        outPath = track.filePath;
        dlProbe = await probeMediaFile(outPath, this.runner);
      } else {
        const failedUrls = [];
        const pickCandidateStreamUrl = (candObj) => {
          let chosenUrl = candObj?.streamUrl || candObj?.videoUrl || candObj?.mediaUrl || candObj?.url || '';
          if (Array.isArray(candObj?.variants) && candObj.variants.length > 0) {
            const validVariants = candObj.variants.filter((v) => v?.url && /^https?:\/\//i.test(v.url) && !failedUrls.includes(v.url));
            if (validVariants.length > 0) {
              const sorted = [...validVariants].sort((a, b) => {
                const ah = Number(a.height) || 480;
                const bh = Number(b.height) || 480;
                return Math.abs(ah - profile.height) - Math.abs(bh - profile.height);
              });
              if (sorted[0]?.url) chosenUrl = sorted[0].url;
            }
          }
          return chosenUrl;
        };

        const downloadCandidate = async (candObj) => {
          const streamUrl = pickCandidateStreamUrl(candObj);
          if (!streamUrl) throw new Error('Playable video URL was unavailable.');
          if (existsSync(outPath)) {
            try { rmSync(outPath, { force: true }); } catch {}
          }
          const headers = { 'User-Agent': UA, ...(candObj?.headers || track.streamHeaders || track.headers || {}) };
          const fmt = String(candObj?.format || track.format || '').toLowerCase();
          const isDash = Boolean(candObj?.isDash || fmt === 'dash' || /\.mpd(\?|$)/i.test(streamUrl));
          const isHls = !isDash && Boolean(candObj?.isHls || fmt === 'hls' || /\.m3u8(\?|$)/i.test(streamUrl));
          const audioUrl = candObj?.audioUrl || candObj?.separateAudioUrl || track?.audioUrl || '';
          const hasSeparateAudio = Boolean(audioUrl && audioUrl !== streamUrl);
          const needsRemux = hasSeparateAudio || isHls || isDash || /\.(mkv|webm|ts)(\?|$)/i.test(streamUrl) || ['mkv', 'dash', 'hls'].includes(fmt);
          const prefAudioLang = candObj?.preferredAudioLang || track.preferredAudioLang || effectiveOrigLang || candObj?.audioLanguage || track.audioLanguage || '';

          if (hasSeparateAudio) {
            emit(`⬇️ Muxing HD video + audio for ${safeName}…`);
            const hdrStr = buildFfmpegHeaders(headers);
            await this.runner('ffmpeg', [
              '-nostdin', '-y',
              '-headers', hdrStr,
              ...(isHls ? ['-allowed_extensions', 'ALL'] : []),
              '-i', streamUrl,
              '-headers', hdrStr,
              '-i', audioUrl,
              '-map', '0:v:0', '-map', '1:a:0', '-sn',
              '-c:v', 'copy',
              '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
              '-shortest',
              '-movflags', '+faststart',
              outPath
            ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
          } else if (needsRemux) {
            emit(`⬇️ Remuxing HD stream to MP4 for ${safeName}…`);
            const hdrStr = buildFfmpegHeaders(headers);
            const audioMapArgs = await selectOriginalAudioMapArgs(streamUrl, this.runner, { headers, preferredAudioLang: prefAudioLang });
            const effectiveMap = audioMapArgs.length ? audioMapArgs : ['-map', '0:v:0', '-map', '0:a:0?'];
            const inputFlags = [
              '-nostdin', '-y',
              '-headers', hdrStr,
              ...(isHls ? ['-allowed_extensions', 'ALL'] : []),
              '-i', streamUrl
            ];
            try {
              await this.runner('ffmpeg', [
                ...inputFlags,
                ...effectiveMap,
                '-sn',
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                '-movflags', '+faststart',
                outPath
              ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
            } catch {
              if (existsSync(outPath)) {
                try { rmSync(outPath, { force: true }); } catch {}
              }
              // Re-encode audio to AAC if source had non-MP4 audio codec (AC3/DTS/Opus)
              await this.runner('ffmpeg', [
                ...inputFlags,
                ...effectiveMap,
                '-sn',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
                '-movflags', '+faststart',
                outPath
              ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
            }
          } else {
            emit(`⬇️ Downloading MP4 (${safeName})…`);
            const res = await this.fetch(streamUrl, {
              headers,
              signal: AbortSignal.timeout(300_000)
            });
            if (!res.ok || !res.body) {
              throw new Error(`HTTP ${res.status} downloading video`);
            }
            const cl = Number(res.headers?.get?.('content-length') || 0);
            // Abort overly massive multi-gigabyte raw files early if duration unknown and > 2.8x limit
            if (cl > limitBytes * 2.8) {
              try { await res.body.cancel(); } catch {}
              throw new Error(`Source file is ${Math.round(cl / (1024 * 1024))} MB which exceeds Telegram compression budget.`);
            }
            await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
          }
          if (!existsSync(outPath) || statSync(outPath).size < 1024) {
            throw new Error('Downloaded file is missing or empty.');
          }
          const probe = await probeMediaFile(outPath, this.runner);
          if (probe.known && (!probe.hasVideo || !probe.hasAudio)) {
            try { rmSync(outPath, { force: true }); } catch {}
            throw new Error(!probe.hasVideo ? 'Downloaded stream has no video track.' : 'Downloaded mirror has no audio track (video-only).');
          }
          return { streamUrl, probe, cand: candObj };
        };

        const rawCandidates = [
          track,
          ...(Array.isArray(track.fallbackStreams) ? track.fallbackStreams : [])
        ].filter((c) => Boolean(c?.streamUrl || c?.videoUrl || c?.mediaUrl || c?.url));
        const initialCandidates = sortDownloadCandidates(rawCandidates, effectiveOrigLang);
        if (!initialCandidates.length) {
          cleanup();
          return { ok: false, reason: 'Playable video URL was unavailable.', cleanup: () => {} };
        }

        let succeeded = false;
        let lastErr = null;
        for (const cand of initialCandidates) {
          const candUrl = pickCandidateStreamUrl(cand);
          if (!candUrl || failedUrls.includes(candUrl)) continue;
          try {
            const dlRes = await downloadCandidate(cand);
            dlProbe = dlRes.probe;
            activeCand = dlRes.cand;
            succeeded = true;
            break;
          } catch (err) {
            lastErr = err;
            failedUrls.push(candUrl);
          }
        }

        if (!succeeded && !item?.filePath && typeof this.app?.movieResolver?.resolve === 'function' && failedUrls.length > 0) {
          emit(`🔁 Switching mirror for verified audio on ${safeName}…`, { force: true });
          const freshRes = await this.app.movieResolver.resolve(item, {
            fetchSubtitles: initialNeedSubs,
            preferredHeight: profile.height,
            originalLanguage: effectiveOrigLang || null,
            allowAdultFeatures: Boolean(allowAdultFeatures),
            excludeUrls: failedUrls,
            onProgress: emitCleanResolver
          }).catch(() => null);
          if (freshRes?.ok && freshRes.track?.streamUrl && !failedUrls.includes(freshRes.track.streamUrl)) {
            track = freshRes.track;
            if (freshRes.subtitles) resolvedSubInfo = freshRes.subtitles;
            const dlRes = await downloadCandidate(track);
            dlProbe = dlRes.probe;
            activeCand = dlRes.cand;
            succeeded = true;
          }
        }

        if (!succeeded) {
          throw lastErr || new Error('All download mirrors failed.');
        }
      }

      if (!existsSync(outPath)) {
        throw new Error('Downloaded file is missing.');
      }
      if (!dlProbe) dlProbe = await probeMediaFile(outPath, this.runner);
      if (dlProbe.known && (!dlProbe.hasVideo || !dlProbe.hasAudio)) {
        throw new Error(!dlProbe.hasVideo ? 'Video stream missing.' : 'Source file has no audio track.');
      }

      let sizeBytes = statSync(outPath).size;
      let durationSeconds = Number(track.durationSeconds || item?.durationSeconds || 0)
        || (dlProbe.known ? dlProbe.durationSeconds : null)
        || await probeDurationSeconds(outPath, this.runner);
      const sourceHeight = (dlProbe.known && dlProbe.height)
        ? dlProbe.height
        : await probeVideoHeight(outPath, this.runner);

      const prefAudioLang = normalizeLangCode(
        activeCand?.preferredAudioLang || track.preferredAudioLang || effectiveOrigLang || activeCand?.audioLanguage || track.audioLanguage || ''
      );
      const bestAudio = pickBestAudioStream(dlProbe.audioStreams || [], prefAudioLang);
      const resolvedAudioLang = normalizeLangCode(
        bestAudio.stream?.language || activeCand?.audioLanguage || track.audioLanguage || ''
      );
      const audioIsDub = Boolean(
        bestAudio.isDub
        || activeCand?.audioIsDub
        || (activeCand === track && track.audioIsDub)
        || (effectiveOrigLang && resolvedAudioLang && resolvedAudioLang !== effectiveOrigLang)
      );

      // Fetch subtitles lazily ONLY if resolved movie is foreign-language original (non-English & not English-dubbed)
      const shouldUseSubtitles = Boolean(
        subtitles === true
        || item?.includeSubtitles
        || (effectiveOrigLang && effectiveOrigLang !== 'en' && effectiveOrigLang !== 'und' && resolvedAudioLang !== 'en' && !audioIsDub)
      );
      const hasEmbeddedEnglishSub = Boolean(
        dlProbe.known && (dlProbe.subtitleStreams || []).some((s) => ['en', 'eng'].includes(normalizeLangCode(s.language)))
      );
      if (shouldUseSubtitles && !hasEmbeddedEnglishSub && !track.subtitlePath && typeof this.app?.movieResolver?.subtitles?.resolveForMedia === 'function') {
        emit(`💬 Matching clean English subtitles for ${safeName}…`);
        const lateSub = await this.app.movieResolver.subtitles.resolveForMedia({
          type: track.mediaKind || item?.type || 'movie',
          id: item?.id || track.id,
          tmdbId: track.tmdbId || item?.tmdbId || null,
          imdbId: track.imdbId || item?.imdbId || null,
          title: item?.title || track.title,
          year: track.year || item?.year || null,
          season: track.season ?? item?.season ?? null,
          episode: track.episode ?? item?.episode ?? null,
          durationSeconds: durationSeconds || null
        }).catch(() => null);
        if (lateSub?.filePath) resolvedSubInfo = lateSub;
      }

      const candidateSubPath = resolvedSubInfo?.filePath || track.subtitlePath || null;
      const validSub = (shouldUseSubtitles && !hasEmbeddedEnglishSub && candidateSubPath)
        ? validateAndPrepareSrt(candidateSubPath, workDir, { durationSeconds, expectEnglish: true })
        : { ok: false };

      const fitPlan = sizeBytes > limitBytes ? planVideoFit({ sizeBytes, durationSeconds, limitBytes }) : null;
      const needsHeightScale = Boolean(
        !item?.filePath && (
          (sourceHeight && sourceHeight > profile.height + 24) ||
          (targetQuality === '360p' && !sourceHeight && sizeBytes > 32 * 1024 * 1024)
        )
      );
      const needsSubBurn = Boolean(!item?.filePath && validSub.ok && validSub.srtPath);
      const audioCodecLower = String(bestAudio.stream?.codec || '').toLowerCase();
      const needsAudioTranscode = Boolean(dlProbe.known && bestAudio.stream && !MP4_UNIVERSAL_AUDIO_CODECS.has(audioCodecLower));
      const needsAudioTrackReselect = Boolean(dlProbe.known && (dlProbe.audioStreams?.length || 0) > 1 && bestAudio.bestIndex > 0);
      const hasUnwantedForeignSoftSubs = Boolean(
        dlProbe.known && !needsSubBurn && (dlProbe.subtitleStreams || []).some((s) => s.language && !['en', 'eng', 'und', ''].includes(s.language))
      );

      if (sizeBytes > limitBytes || needsHeightScale || needsSubBurn) {
        if (fitPlan && fitPlan.action === 'reject') {
          cleanup();
          return {
            ok: false,
            reason: `File size (${Math.round(sizeBytes / (1024 * 1024))} MB) exceeds Telegram upload limit (${Math.round(limitBytes / (1024 * 1024))} MB).`,
            cleanup: () => {}
          };
        }
        const fitHeight = fitPlan?.action === 'transcode'
          ? Math.min(profile.height, fitPlan.height)
          : (sourceHeight ? Math.min(profile.height, sourceHeight) : profile.height);
        const targetVideoKbps = fitPlan?.action === 'transcode'
          ? Math.min(profile.videoKbps, fitPlan.videoKbps)
          : profile.videoKbps;
        const targetMaxrateKbps = fitPlan?.action === 'transcode'
          ? Math.min(profile.maxrateKbps, Math.floor(targetVideoKbps * 1.15))
          : profile.maxrateKbps;
        const targetAudioKbps = fitPlan?.action === 'transcode'
          ? Math.min(profile.audioKbps, DEFAULT_AUDIO_KBPS)
          : profile.audioKbps;
        emit(
          needsSubBurn && !needsHeightScale && sizeBytes <= limitBytes
            ? `💬 Embedding verified English subtitles (${safeName})…`
            : `🗜 Optimizing ${Math.round(sizeBytes / (1024 * 1024))} MB video to ${profile.short} (${fitHeight}p)…`,
          { force: true }
        );
        const fitPath = join(workDir, `${safeName}_${profile.short}.mp4`);
        const fitAudioMapArgs = (dlProbe.known && dlProbe.audioStreams?.length)
          ? ['-map', '0:v:0', '-map', `0:a:${bestAudio.bestIndex}`]
          : await selectOriginalAudioMapArgs(outPath, this.runner, { preferredAudioLang: prefAudioLang });
        const vfParts = [`scale=-2:'min(${fitHeight},ih)'`];
        if (needsSubBurn) {
          vfParts.push(`subtitles='${escapeFfmpegFilterPath(validSub.srtPath)}:charenc=UTF-8'`);
        }
        await this.runner('ffmpeg', [
          '-nostdin', '-y',
          '-i', outPath,
          ...fitAudioMapArgs,
          '-sn',
          '-vf', vfParts.join(','),
          '-c:v', 'libx264', '-preset', 'veryfast',
          '-crf', String(profile.crf),
          '-maxrate', `${targetMaxrateKbps}k`,
          '-bufsize', `${Math.max(targetMaxrateKbps * 2, targetVideoKbps * 2)}k`,
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', `${targetAudioKbps}k`, '-ac', '2',
          '-movflags', '+faststart',
          fitPath
        ], { timeout: 900_000, maxBuffer: 4 * 1024 * 1024 });
        if (existsSync(fitPath)) {
          const postProbe = await probeMediaFile(fitPath, this.runner);
          if (postProbe.known && (!postProbe.hasVideo || !postProbe.hasAudio)) {
            cleanup();
            return { ok: false, reason: 'Encoded output lost audio track.', cleanup: () => {} };
          }
          if (outPath !== track.filePath) {
            try { rmSync(outPath, { force: true }); } catch {}
          }
          outPath = fitPath;
          sizeBytes = statSync(outPath).size;
        }
        if (sizeBytes > limitBytes) {
          cleanup();
          return {
            ok: false,
            reason: `File size (${Math.round(sizeBytes / (1024 * 1024))} MB) exceeds Telegram upload limit (${Math.round(limitBytes / (1024 * 1024))} MB).`,
            cleanup: () => {}
          };
        }
      } else if (!item?.filePath && (needsAudioTranscode || needsAudioTrackReselect || hasUnwantedForeignSoftSubs)) {
        // Fast 1-3s stream-copy remux: fixes incompatible audio codec (AC3/DTS/Opus -> AAC), removes wrong dubs/foreign soft-subs
        emit(`🔧 Normalizing clean AAC audio for ${safeName}…`);
        const fixedPath = join(workDir, `${safeName}_clean.mp4`);
        const fastArgs = [
          '-nostdin', '-y',
          '-i', outPath,
          '-map', '0:v:0', '-map', `0:a:${bestAudio.bestIndex}`,
          '-sn',
          '-c:v', 'copy',
          ...(needsAudioTranscode ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-c:a', 'copy']),
          '-movflags', '+faststart',
          fixedPath
        ];
        try {
          await this.runner('ffmpeg', fastArgs, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
          if (existsSync(fixedPath) && statSync(fixedPath).size > 1024) {
            const fixProbe = await probeMediaFile(fixedPath, this.runner);
            if (!fixProbe.known || (fixProbe.hasVideo && fixProbe.hasAudio)) {
              if (outPath !== track.filePath) {
                try { rmSync(outPath, { force: true }); } catch {}
              }
              outPath = fixedPath;
              sizeBytes = statSync(outPath).size;
            }
          }
        } catch {
          try { rmSync(fixedPath, { force: true }); } catch {}
        }
      }

      return {
        ok: true,
        cachedFileId: null,
        quality: targetQuality,
        cacheKey: this.#cacheKey(item, limitBytes, targetQuality) || this.#cacheKey(track, limitBytes, targetQuality),
        filePath: outPath,
        filename: `${safeName}_${profile.short}.mp4`,
        sizeBytes,
        durationSeconds: durationSeconds ? Math.round(durationSeconds) : null,
        title: displayTitle,
        audioLanguage: resolvedAudioLang || null,
        audioIsDub,
        subtitleApplied: needsSubBurn,
        hasEmbeddedEnglishSub,
        track,
        cleanup: outPath === track.filePath ? () => {} : cleanup
      };
    } catch (err) {
      cleanup();
      return { ok: false, reason: err?.message || 'Video download failed.', cleanup: () => {} };
    }
  }

  /**
   * Download & send a single movie, episode, or adult video directly into chat with clean branding.
   */
  async sendSingleVideo(ctx, itemOrTrack, {
    vcCallbackData = null,
    spoiler = false,
    onProgress = null,
    quality = '480p',
    allowAdultFeatures = null
  } = {}) {
    const targetQuality = normalizeDownloadQuality(quality);
    const effectiveAllowAdult = allowAdultFeatures !== null
      ? Boolean(allowAdultFeatures)
      : Number(ctx?.chatId || ctx?.chat?.id || 0) > 0;
    const runPrepare = () => this.prepareVideoFile(itemOrTrack, {
      onProgress,
      quality: targetQuality,
      allowAdultFeatures: effectiveAllowAdult
    });
    const dedupeId = `${itemOrTrack?.id || itemOrTrack?.title || 'single'}_s${itemOrTrack?.season ?? 0}_e${itemOrTrack?.episode ?? 0}_${targetQuality}`;
    const prepared = typeof this.app?.jobPlanner?.schedule === 'function'
      ? await this.app.jobPlanner.schedule('media', { dedupeKey: `mvdl_${dedupeId}` }, runPrepare)
      : await runPrepare();
    if (!prepared.ok) return prepared;

    const api = ctx.api || this.app?.telegram?.api;
    const botUsername = api?.botUsername || api?.me?.username || this.app?.telegram?.botUsername || 'Lancy_easy_bot';
    const qTag = prepared.quality || targetQuality;
    const durTag = prepared.durationSeconds ? ` · ⏱ ${durationText(prepared.durationSeconds)}` : '';
    const langTag = prepared.audioIsDub
      ? ` · ⚠️ Dub (${String(prepared.audioLanguage || 'ALT').toUpperCase()})`
      : (prepared.audioLanguage ? ` · 🔊 ${String(prepared.audioLanguage).toUpperCase()}` : '');
    const subTag = prepared.subtitleApplied ? ' · 💬 EN Subs' : (prepared.hasEmbeddedEnglishSub ? ' · 💬 EN' : '');
    const sizeLabel = prepared.sizeBytes > 0
      ? `📦 ${Math.max(1, Math.round(prepared.sizeBytes / (1024 * 1024)))} MB · ${qTag} MP4`
      : `⚡ Instant Telegram ${qTag} MP4`;
    const caption =
      `🎬 <b>${escapeHtml(prepared.title)}</b>\n` +
      `<blockquote>${sizeLabel}${escapeHtml(durTag)}${escapeHtml(langTag)}${escapeHtml(subTag)} · 🤖 @${escapeHtml(botUsername)}</blockquote>`;

    const extra = {
      caption,
      parse_mode: 'HTML',
      filename: prepared.filename,
      supports_streaming: true,
      ...(prepared.durationSeconds ? { duration: prepared.durationSeconds } : {}),
      ...(spoiler ? { has_spoiler: true } : {}),
      ...(vcCallbackData ? {
        reply_markup: {
          inline_keyboard: [[{
            text: '🎙️ Stream in VC',
            callback_data: vcCallbackData,
            style: 'success'
          }]]
        }
      } : {})
    };

    try {
      const mediaPayload = prepared.cachedFileId
        ? prepared.cachedFileId
        : {
          filePath: prepared.filePath,
          filename: prepared.filename,
          contentType: 'video/mp4'
        };
      const sent = await api.sendVideo(ctx.chatId, mediaPayload, extra);
      const returnedFileId = this.#extractFileId(sent);
      if (returnedFileId && prepared.cacheKey) {
        this.#saveCachedFileId(prepared.cacheKey, returnedFileId, prepared.title, prepared.durationSeconds);
      }
      if (sent?.message_id) {
        ctx.controller?.markMediaDeliveryMessage?.(sent.message_id);
        this.app?.telegram?.markMediaDeliveryMessage?.(sent.message_id);
      }
      return { ok: true, sent, prepared };
    } finally {
      prepared.cleanup();
    }
  }

  /**
   * Build & deliver one paginated Bot API 10.3 album slide batch of multi-episode / multi-movie videos.
   * Uses native `b.slideshow` + `editMessageRich` in-place when payload fits cleanly, or `sendMediaGroup`
   * paired with one single clean controller card (`◀ Prev Slide` / `Next Slide ▶`) to avoid chat clutter.
   */
  async deliverAlbumSlidePage(ctx, ms, page = 0, {
    buildNavCallback,
    streamPageCallback = null,
    keepCallback = null,
    isKept = false,
    backCallback = null,
    spoiler = false,
    onProgress = null,
    quality = '480p'
  } = {}) {
    const targetQuality = normalizeDownloadQuality(quality);
    if (!Array.isArray(ms.dlMediaMessageIds)) ms.dlMediaMessageIds = [];
    if (!Array.isArray(ms.dlKeptPages)) ms.dlKeptPages = [];
    if (!Array.isArray(ms.dlKeptMessageIds)) ms.dlKeptMessageIds = [];

    const manifest = ms?.dlManifest;
    const items = Array.isArray(manifest?.items) ? manifest.items : [];
    const pageSize = Math.max(1, Math.min(10, Number(manifest?.pageSize) || 4));
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
    ms.dlPage = safePage;

    const start = safePage * pageSize;
    const slice = items.slice(start, start + pageSize);
    if (!slice.length) {
      return { ok: false, reason: 'No items selected for this slide page.' };
    }

    const preparedList = [];
    const failedTitles = [];
    const limitBytes = this.getLimitBytes();
    const api = ctx.api || this.app?.telegram?.api;
    const botUsername = api?.botUsername || api?.me?.username || this.app?.telegram?.botUsername || 'Lancy_easy_bot';
    const keptSet = new Set(ms.dlKeptMessageIds.map(Number).filter(Number.isFinite));
    const oldMediaIds = ms.dlMediaMessageIds.filter((id) => !keptSet.has(Number(id)));
    const reusableCardId = (ms.dlMessageId && !keptSet.has(Number(ms.dlMessageId)))
      ? ms.dlMessageId
      : ((ctx.query?.message?.message_id && !keptSet.has(Number(ctx.query.message.message_id)) && Number(ctx.query.message.message_id) !== Number(ms.messageId))
        ? ctx.query.message.message_id
        : null);

    const allInstant = slice.every((d) => Boolean(d?.filePath || this.hasCachedVideo(d, targetQuality)));
    let tracker = null;
    if (!allInstant && typeof api?.sendRichMessage === 'function') {
      const trackerReplyId = (Number(ctx.chatId) < 0 && !reusableCardId)
        ? (ctx.message?.message_id || ctx.query?.message?.message_id || ms.messageId || null)
        : null;
      tracker = new ProgressTracker({
        api,
        chatId: ctx.chatId,
        messageId: reusableCardId,
        replyToMessageId: trackerReplyId,
        heartbeatMs: 2000,
        action: 'upload_video'
      });
      await tracker.live((state, { elapsedMs }) => {
        const sec = Math.max(0, Math.floor(elapsedMs / 1000));
        const pb = new RichMessageBuilder();
        pb.bannerHeader([
          `🎬 ${String(manifest.title || 'CINEMA SLIDE').slice(0, 44)}`,
          `Slide ${safePage + 1}/${totalPages} · ${state.completed || 0}/${state.total || slice.length} ready`
        ], { size: 2 });
        pb.blockquote(rt.text(`${state.statusLine || 'Preparing episodes…'}\n⏱ Elapsed: ${sec}s`));
        pb.validate();
        return pb.toJSON();
      }, {
        completed: 0,
        total: slice.length,
        statusLine: `📦 Preparing Slide ${safePage + 1}/${totalPages}…`
      }).catch(() => {});
      if (tracker.messageId) {
        this.app?.movieSessions?.registerMessage?.(ms, tracker.messageId, 'dl');
      }
    }

    const emitProgress = (line, patch = {}) => {
      if (typeof onProgress === 'function') void onProgress(line);
      if (tracker) tracker.set({ statusLine: line, ...patch });
    };

    try {
      const results = new Array(slice.length);
      let cursor = 0;
      let completed = 0;
      const stressLevel = this.app?.jobPlanner?.sampleStress?.()?.pressureLevel || 'nominal';
      const concurrency = (stressLevel === 'high' || stressLevel === 'critical') ? 1 : Math.min(3, slice.length);
      const worker = async () => {
        while (cursor < slice.length) {
          const idx = cursor++;
          const desc = slice[idx];
          await this.app?.jobPlanner?.yieldIfStressed?.('media');
          const label = desc.episode
            ? `S${String(desc.season).padStart(2, '0')}E${String(desc.episode).padStart(2, '0')}`
            : String(desc.title || `Item ${start + idx + 1}`).slice(0, 36);
          emitProgress(`📦 Preparing ${targetQuality} · ${completed}/${slice.length} ready (${label})…`, { completed, total: slice.length });
          const p = await this.prepareVideoFile(desc, {
            quality: targetQuality
          });
          completed++;
          results[idx] = { desc, label, p };
          emitProgress(`📦 Prepared ${completed}/${slice.length} (${label})`, { completed, total: slice.length });
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      for (const entry of results) {
        if (entry?.p?.ok) preparedList.push({ desc: entry.desc, ...entry.p });
        else if (entry) failedTitles.push(`${entry.label}: ${entry.p?.reason || 'Unavailable'}`);
      }

      if (!preparedList.length) {
        if (tracker && !reusableCardId) await tracker.cleanup().catch(() => {});
        return {
          ok: false,
          reason: failedTitles[0] || 'Could not download any videos in this slide batch.'
        };
      }

      const uploadBatchBytes = preparedList.reduce((sum, x) => sum + (x.cachedFileId ? 0 : (x.sizeBytes || 0)), 0);
      const batchFitsSinglePost = uploadBatchBytes <= Math.floor(limitBytes * 0.88);
      const pageAlreadyKept = Boolean(isKept || ms.dlKeptPages.includes(safePage));
      const navRow = [];
      if (safePage > 0 && typeof buildNavCallback === 'function') {
        const prevStart = (safePage - 1) * pageSize + 1;
        const prevEnd = safePage * pageSize;
        navRow.push(richButton.callback(`◀ Prev (${prevStart}–${prevEnd})`, buildNavCallback(safePage - 1), { style: 'primary' }));
      }
      if (safePage < totalPages - 1 && typeof buildNavCallback === 'function') {
        const nextStart = (safePage + 1) * pageSize + 1;
        const nextEnd = Math.min(items.length, (safePage + 2) * pageSize);
        navRow.push(richButton.callback(`Next (${nextStart}–${nextEnd}) ▶`, buildNavCallback(safePage + 1), { style: 'primary' }));
      }

      const buildAlbumCard = (withSlideshowBlocks) => {
        const b = new RichMessageBuilder();
        b.bannerHeader([
          `🎬 ${String(manifest.title || 'CINEMA ALBUM').slice(0, 44)}`,
          `Slide ${safePage + 1}/${totalPages} · Items ${start + 1}–${start + preparedList.length} of ${items.length}`
        ], { size: 2 });

        if (withSlideshowBlocks) {
          const slideItems = preparedList.map((p, idx) => block.video(p.cachedFileId ? p.cachedFileId : `attach://mv_dl_${idx}`));
          if (slideItems.length === 1) b.video(preparedList[0].cachedFileId ? preparedList[0].cachedFileId : 'attach://mv_dl_0', preparedList[0].title);
          else b.slideshow(slideItems);
          b.divider();
        }

        b.table(
          preparedList.map((p, idx) => [
            `${start + idx + 1}.`,
            String(p.title).slice(0, 38),
            `${p.cachedFileId ? `${p.quality || targetQuality} ⚡` : `${p.quality || targetQuality} · ${Math.max(1, Math.round(p.sizeBytes / (1024 * 1024)))} MB`}${p.durationSeconds ? ` · ${durationText(p.durationSeconds)}` : ''}`
          ]),
          { striped: true, bordered: true, compact: true }
        );

        if (failedTitles.length) {
          b.blockquote(rt.text(`⚠️ Skipped: ${failedTitles.slice(0, 3).join(' | ')}`));
        }

        b.paragraph(rt.italic(`🤖 Lancy Music (@${botUsername}) · Clean Slide Delivery`));
        if (navRow.length) b.buttons(navRow);
        const actionRow = [];
        if (typeof keepCallback === 'function') {
          actionRow.push(richButton.callback(pageAlreadyKept ? '✅ Kept in Chat' : '💾 Keep Slide', keepCallback(safePage), { style: pageAlreadyKept ? 'success' : 'primary' }));
        }
        if (streamPageCallback) actionRow.push(richButton.callback('📺 Stream This Slide in VC', streamPageCallback(safePage), { style: 'success' }));
        if (backCallback) actionRow.push(richButton.callback('« Back to Episodes', backCallback()));
        if (actionRow.length) b.buttons(actionRow);
        b.validate();
        return b.toJSON();
      };

      const deleteOldUnkeptMedia = async () => {
        if (!oldMediaIds.length || typeof api?.deleteMessage !== 'function') return;
        await Promise.all(oldMediaIds.map((mid) => api.deleteMessage(ctx.chatId, mid).catch(() => {})));
      };

      if (batchFitsSinglePost && !spoiler) {
        const files = {};
        preparedList.forEach((p, idx) => {
          if (!p.cachedFileId) {
            files[`mv_dl_${idx}`] = {
              filePath: p.filePath,
              filename: p.filename,
              contentType: 'video/mp4'
            };
          }
        });
        const rich = buildAlbumCard(true);
        const filesArg = Object.keys(files).length ? files : null;
        let sent = null;
        if (tracker) {
          sent = await tracker.finish(rich, filesArg);
        } else {
          if (reusableCardId && typeof api.editMessageRich === 'function') {
            try {
              sent = await api.editMessageRich(ctx.chatId, reusableCardId, rich, {}, filesArg);
            } catch {
              sent = null;
            }
          }
          if (!sent) {
            sent = await api.sendRichMessage(ctx.chatId, rich, {}, filesArg);
            if (reusableCardId && sent?.message_id && reusableCardId !== sent.message_id) {
              await api.deleteMessage?.(ctx.chatId, reusableCardId)?.catch?.(() => {});
            }
          }
        }
        await deleteOldUnkeptMedia();
        ms.dlMediaMessageIds = [];
        const msgId = sent?.message_id || tracker?.messageId || reusableCardId;
        if (preparedList.length === 1) {
          const singleFid = this.#extractFileId(sent);
          if (singleFid && preparedList[0].cacheKey) {
            this.#saveCachedFileId(preparedList[0].cacheKey, singleFid, preparedList[0].title, preparedList[0].durationSeconds);
          }
        }
        if (msgId) {
          this.app?.movieSessions?.registerMessage?.(ms, msgId, 'dl');
          ctx.controller?.markMediaDeliveryMessage?.(msgId);
          this.app?.telegram?.markMediaDeliveryMessage?.(msgId);
        }
        return { ok: true, messageId: msgId, count: preparedList.length };
      }

      // Large multi-file batch: chunk sendMediaGroup(s) so each HTTP upload stays safely under limit, then 1 clean slide controller
      emitProgress(`📤 Uploading ${preparedList.length} HD files cleanly…`);
      let currentGroup = [];
      let currentGroupBytes = 0;
      const groups = [];
      for (const p of preparedList) {
        const pBytes = p.cachedFileId ? 0 : (p.sizeBytes || 0);
        if (currentGroup.length >= 10 || (currentGroup.length > 0 && currentGroupBytes + pBytes > limitBytes)) {
          groups.push(currentGroup);
          currentGroup = [];
          currentGroupBytes = 0;
        }
        currentGroup.push(p);
        currentGroupBytes += pBytes;
      }
      if (currentGroup.length) groups.push(currentGroup);

      const newMediaIds = [];
      for (const grp of groups) {
        const grpFiles = {};
        const mediaArr = grp.map((p, idx) => {
          const field = `grp_${idx}`;
          if (!p.cachedFileId) {
            grpFiles[field] = { filePath: p.filePath, filename: p.filename, contentType: 'video/mp4' };
          }
          return {
            type: 'video',
            media: p.cachedFileId ? p.cachedFileId : `attach://${field}`,
            caption: idx === 0 ? `🎬 <b>${escapeHtml(p.title)}</b> (Slide ${safePage + 1}/${totalPages})` : `🎬 <b>${escapeHtml(p.title)}</b>`,
            parse_mode: 'HTML',
            supports_streaming: true,
            ...(p.durationSeconds ? { duration: p.durationSeconds } : {}),
            ...(spoiler ? { has_spoiler: true } : {})
          };
        });
        if (mediaArr.length === 1) {
          const sole = grp[0];
          const mediaPayload = sole.cachedFileId
            ? sole.cachedFileId
            : { filePath: sole.filePath, filename: sole.filename, contentType: 'video/mp4' };
          const sentVid = await api.sendVideo(ctx.chatId, mediaPayload, {
            caption: mediaArr[0].caption,
            parse_mode: 'HTML',
            supports_streaming: true,
            ...(sole.durationSeconds ? { duration: sole.durationSeconds } : {}),
            ...(spoiler ? { has_spoiler: true } : {})
          });
          if (sentVid?.message_id) {
            newMediaIds.push(sentVid.message_id);
            const fid = this.#extractFileId(sentVid);
            if (fid && sole.cacheKey) this.#saveCachedFileId(sole.cacheKey, fid, sole.title, sole.durationSeconds);
          }
        } else {
          const sentGrp = await api.sendMediaGroup(ctx.chatId, mediaArr, {}, Object.keys(grpFiles).length ? grpFiles : null);
          if (Array.isArray(sentGrp)) {
            sentGrp.forEach((msgObj, idx) => {
              if (msgObj?.message_id) newMediaIds.push(msgObj.message_id);
              const fid = this.#extractFileId(msgObj);
              const itemRef = grp[idx];
              if (fid && itemRef?.cacheKey) this.#saveCachedFileId(itemRef.cacheKey, fid, itemRef.title, itemRef.durationSeconds);
            });
          } else if (sentGrp?.message_id) {
            newMediaIds.push(sentGrp.message_id);
          }
        }
      }

      if (tracker) await tracker.cleanup().catch(() => {});
      await deleteOldUnkeptMedia();
      if (reusableCardId && (!tracker || reusableCardId !== tracker.messageId)) {
        await api.deleteMessage?.(ctx.chatId, reusableCardId)?.catch?.(() => {});
      }

      const navCard = buildAlbumCard(false);
      const navSent = await api.sendRichMessage(ctx.chatId, navCard);
      ms.dlMediaMessageIds = [];
      for (const mid of newMediaIds) {
        this.app?.movieSessions?.registerMessage?.(ms, mid, 'dl_media');
        ctx.controller?.markMediaDeliveryMessage?.(mid);
        this.app?.telegram?.markMediaDeliveryMessage?.(mid);
      }
      if (navSent?.message_id) {
        this.app?.movieSessions?.registerMessage?.(ms, navSent.message_id, 'dl');
        ctx.controller?.markMediaDeliveryMessage?.(navSent.message_id);
        this.app?.telegram?.markMediaDeliveryMessage?.(navSent.message_id);
      }
      return { ok: true, messageId: navSent?.message_id, mediaMessageIds: newMediaIds, count: preparedList.length };
    } finally {
      for (const p of preparedList) p.cleanup?.();
    }
  }
}
