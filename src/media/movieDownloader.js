import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
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

const execFileAsync = promisify(execFile);
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_AUDIO_KBPS = 96;

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
    const type = String(item.type || (item.episode != null || item.episodeNumber != null ? 'tv' : 'movie')).toLowerCase();
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
  async prepareVideoFile(item, { onProgress = null, skipCache = false, quality = '480p' } = {}) {
    const emit = (msg) => { if (typeof onProgress === 'function') void onProgress(msg); };
    const limitBytes = this.getLimitBytes();
    const targetQuality = normalizeDownloadQuality(quality);
    const profile = DOWNLOAD_QUALITY_PROFILES[targetQuality] || DOWNLOAD_QUALITY_PROFILES['480p'];
    const cacheKey = !skipCache && !item?.filePath ? this.#cacheKey(item, limitBytes, targetQuality) : null;
    if (cacheKey) {
      const cached = this.#lookupCachedFileId(cacheKey);
      if (cached?.file_id) {
        const displayTitle = item?.title || cached.title || 'Movie';
        emit(`⚡ Instant ${profile.short} cache hit for ${displayTitle}!`);
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
      let track = item?.streamUrl || item?.videoUrl || item?.filePath ? item : null;
      if (!track && this.app?.movieResolver) {
        emit(`🔎 Resolving ${profile.short} stream for ${item?.title || 'title'}…`);
        const res = await this.app.movieResolver.resolve(item, {
          fetchSubtitles: false,
          preferredHeight: profile.height,
          onProgress: emit
        });
        if (!res?.ok || !res.track) {
          return { ok: false, reason: res?.reason || 'No downloadable stream found for this title.', cleanup };
        }
        track = res.track;
      }
      if (!track) {
        return { ok: false, reason: 'No stream metadata available to download.', cleanup };
      }

      const displayTitle = track.title || item?.title || 'Movie';
      const safeName = sanitizeFilename(displayTitle, 'movie');
      let outPath = join(workDir, `${safeName}.mp4`);

      if (track.filePath && existsSync(track.filePath)) {
        outPath = track.filePath;
      } else {
        const streamUrl = track.streamUrl || track.videoUrl || track.mediaUrl;
        if (!streamUrl) {
          cleanup();
          return { ok: false, reason: 'Playable video URL was unavailable.', cleanup: () => {} };
        }
        const headers = { 'User-Agent': UA, ...(track.streamHeaders || track.headers || {}) };
        const isDash = Boolean(track.isDash || track.format === 'dash' || /\.mpd(\?|$)/i.test(streamUrl));
        const isHls = !isDash && Boolean(track.isHls || track.format === 'hls' || /\.m3u8(\?|$)/i.test(streamUrl));
        const needsRemux = isHls || isDash || /\.(mkv|webm|ts)(\?|$)/i.test(streamUrl) || ['mkv', 'dash', 'hls'].includes(String(track.format || '').toLowerCase());

        if (needsRemux) {
          emit(`⬇️ Remuxing HD stream to MP4 for ${safeName}…`);
          const hdrStr = buildFfmpegHeaders(headers);
          const inputFlags = [
            '-nostdin', '-y',
            '-headers', hdrStr,
            ...(isHls ? ['-allowed_extensions', 'ALL'] : []),
            '-i', streamUrl
          ];
          try {
            await this.runner('ffmpeg', [
              ...inputFlags,
              '-c', 'copy',
              '-bsf:a', 'aac_adtstoasc',
              '-movflags', '+faststart',
              outPath
            ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
          } catch {
            // Re-encode audio to AAC if source had non-MP4 audio codec (AC3/DTS/Opus)
            await this.runner('ffmpeg', [
              ...inputFlags,
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
          const limitBytes = this.getLimitBytes();
          // Abort overly massive multi-gigabyte raw files early if duration unknown and > 2.8x limit
          if (cl > limitBytes * 2.8) {
            try { await res.body.cancel(); } catch {}
            throw new Error(`Source file is ${Math.round(cl / (1024 * 1024))} MB which exceeds Telegram compression budget.`);
          }
          await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
        }
      }

      if (!existsSync(outPath)) {
        throw new Error('Downloaded file is missing.');
      }

      let sizeBytes = statSync(outPath).size;
      let durationSeconds = Number(track.durationSeconds || item?.durationSeconds || 0) || await probeDurationSeconds(outPath, this.runner);
      const sourceHeight = await probeVideoHeight(outPath, this.runner);
      const fitPlan = sizeBytes > limitBytes ? planVideoFit({ sizeBytes, durationSeconds, limitBytes }) : null;
      const needsHeightScale = Boolean(
        !item?.filePath && (
          (sourceHeight && sourceHeight > profile.height + 24) ||
          (targetQuality === '360p' && !sourceHeight && sizeBytes > 32 * 1024 * 1024)
        )
      );

      if (sizeBytes > limitBytes || needsHeightScale) {
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
          : profile.height;
        const targetVideoKbps = fitPlan?.action === 'transcode'
          ? Math.min(profile.videoKbps, fitPlan.videoKbps)
          : profile.videoKbps;
        const targetMaxrateKbps = fitPlan?.action === 'transcode'
          ? Math.min(profile.maxrateKbps, Math.floor(targetVideoKbps * 1.15))
          : profile.maxrateKbps;
        const targetAudioKbps = fitPlan?.action === 'transcode'
          ? Math.min(profile.audioKbps, DEFAULT_AUDIO_KBPS)
          : profile.audioKbps;
        emit(`🗜 Optimizing ${Math.round(sizeBytes / (1024 * 1024))} MB video to ${profile.short} (${fitHeight}p)…`);
        const fitPath = join(workDir, `${safeName}_${profile.short}.mp4`);
        await this.runner('ffmpeg', [
          '-nostdin', '-y',
          '-i', outPath,
          '-vf', `scale=-2:'min(${fitHeight},ih)'`,
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
    quality = '480p'
  } = {}) {
    const targetQuality = normalizeDownloadQuality(quality);
    const prepared = await this.prepareVideoFile(itemOrTrack, { onProgress, quality: targetQuality });
    if (!prepared.ok) return prepared;

    const api = ctx.api || this.app?.telegram?.api;
    const botUsername = api?.botUsername || api?.me?.username || this.app?.telegram?.botUsername || 'Lancy_easy_bot';
    const qTag = prepared.quality || targetQuality;
    const durTag = prepared.durationSeconds ? ` · ⏱ ${durationText(prepared.durationSeconds)}` : '';
    const sizeLabel = prepared.sizeBytes > 0
      ? `📦 ${Math.max(1, Math.round(prepared.sizeBytes / (1024 * 1024)))} MB · ${qTag} MP4`
      : `⚡ Instant Telegram ${qTag} MP4`;
    const caption =
      `🎬 <b>${escapeHtml(prepared.title)}</b>\n` +
      `<blockquote>${sizeLabel}${escapeHtml(durTag)} · 🤖 @${escapeHtml(botUsername)}</blockquote>`;

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
      tracker = new ProgressTracker({
        api,
        chatId: ctx.chatId,
        messageId: reusableCardId,
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
      const concurrency = Math.min(2, slice.length);
      const worker = async () => {
        while (cursor < slice.length) {
          const idx = cursor++;
          const desc = slice[idx];
          const label = desc.episode
            ? `S${String(desc.season).padStart(2, '0')}E${String(desc.episode).padStart(2, '0')}`
            : String(desc.title || `Item ${start + idx + 1}`).slice(0, 36);
          emitProgress(`📦 Preparing ${targetQuality} [${completed + 1}/${slice.length}] ${label}…`, { completed, total: slice.length });
          const p = await this.prepareVideoFile(desc, {
            quality: targetQuality,
            onProgress: (line) => emitProgress(line, { completed, total: slice.length })
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
      for (const p of preparedList) p.cleanup();
    }
  }
}
