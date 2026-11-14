import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { uploadLimitBytes, planVideoFit } from './telegramLimits.js';
import { RichMessageBuilder, block, rt, richButton } from '../telegram/rich.js';
import { escapeHtml } from '../telegram/rich.js';
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
    try { mkdirSync(this.cacheDir, { recursive: true }); } catch {}
  }

  getLimitBytes() {
    return uploadLimitBytes();
  }

  /**
   * Resolve and materialize a single movie, TV episode, or already-playing track into an .mp4 on disk.
   * Caller must invoke `cleanup()` when upload finishes.
   */
  async prepareVideoFile(item, { onProgress = null } = {}) {
    const emit = (msg) => { if (typeof onProgress === 'function') void onProgress(msg); };
    const workDir = join(this.cacheDir, `${Date.now()}_${randomBytes(3).toString('hex')}`);
    mkdirSync(workDir, { recursive: true });

    const cleanup = () => {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    };

    try {
      let track = item?.streamUrl || item?.videoUrl || item?.filePath ? item : null;
      if (!track && this.app?.movieResolver) {
        emit(`🔎 Resolving HD stream for ${item?.title || 'title'}…`);
        const res = await this.app.movieResolver.resolve(item, {
          fetchSubtitles: false,
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
        const isHls = Boolean(track.isHls || track.format === 'hls' || /\.m3u8(\?|$)/i.test(streamUrl));
        const needsRemux = isHls || /\.(mkv|webm|ts)(\?|$)/i.test(streamUrl) || String(track.format || '').toLowerCase() === 'mkv';

        if (needsRemux) {
          emit(`⬇️ Remuxing HD stream to MP4 for ${safeName}…`);
          const hdrStr = buildFfmpegHeaders(headers);
          try {
            await this.runner('ffmpeg', [
              '-nostdin', '-y',
              '-headers', hdrStr,
              '-i', streamUrl,
              '-c', 'copy',
              '-bsf:a', 'aac_adtstoasc',
              '-movflags', '+faststart',
              outPath
            ], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
          } catch {
            // Re-encode audio to AAC if source had non-MP4 audio codec (AC3/DTS/Opus)
            await this.runner('ffmpeg', [
              '-nostdin', '-y',
              '-headers', hdrStr,
              '-i', streamUrl,
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
      const limitBytes = this.getLimitBytes();
      let durationSeconds = Number(track.durationSeconds || item?.durationSeconds || 0) || await probeDurationSeconds(outPath, this.runner);

      if (sizeBytes > limitBytes) {
        const plan = planVideoFit({ sizeBytes, durationSeconds, limitBytes });
        if (plan.action === 'transcode') {
          emit(`🗜 Fitting ${Math.round(sizeBytes / (1024 * 1024))} MB video within ${Math.round(limitBytes / (1024 * 1024))} MB Telegram cap (${plan.height}p)…`);
          const fitPath = join(workDir, `${safeName}_fit.mp4`);
          await this.runner('ffmpeg', [
            '-nostdin', '-y',
            '-i', outPath,
            '-vf', `scale=-2:'min(${plan.height},ih)'`,
            '-c:v', 'libx264', '-preset', 'veryfast',
            '-b:v', `${plan.videoKbps}k`,
            '-maxrate', `${Math.floor(plan.videoKbps * 1.15)}k`,
            '-bufsize', `${plan.videoKbps * 2}k`,
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', `${DEFAULT_AUDIO_KBPS}k`, '-ac', '2',
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
        filePath: outPath,
        filename: `${safeName}.mp4`,
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
    onProgress = null
  } = {}) {
    const prepared = await this.prepareVideoFile(itemOrTrack, { onProgress });
    if (!prepared.ok) return prepared;

    const api = ctx.api || this.app?.telegram?.api;
    const botUsername = api?.botUsername || api?.me?.username || this.app?.telegram?.botUsername || 'Lancy_easy_bot';
    const durTag = prepared.durationSeconds ? ` · ⏱ ${durationText(prepared.durationSeconds)}` : '';
    const sizeMb = Math.max(1, Math.round(prepared.sizeBytes / (1024 * 1024)));
    const caption =
      `🎬 <b>${escapeHtml(prepared.title)}</b>\n` +
      `<blockquote>📦 ${sizeMb} MB MP4${escapeHtml(durTag)} · 🤖 @${escapeHtml(botUsername)}</blockquote>`;

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
      const sent = await api.sendVideo(ctx.chatId, {
        filePath: prepared.filePath,
        filename: prepared.filename,
        contentType: 'video/mp4'
      }, extra);
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
    backCallback = null,
    spoiler = false,
    onProgress = null
  } = {}) {
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

    try {
      for (let i = 0; i < slice.length; i++) {
        const desc = slice[i];
        const label = desc.episode
          ? `S${String(desc.season).padStart(2, '0')}E${String(desc.episode).padStart(2, '0')}`
          : String(desc.title || `Item ${start + i + 1}`).slice(0, 36);
        onProgress?.(`📦 Preparing [${i + 1}/${slice.length}] ${label}…`);
        const p = await this.prepareVideoFile(desc, { onProgress });
        if (p.ok) preparedList.push({ desc, ...p });
        else failedTitles.push(`${label}: ${p.reason}`);
      }

      if (!preparedList.length) {
        return {
          ok: false,
          reason: failedTitles[0] || 'Could not download any videos in this slide batch.'
        };
      }

      const totalBatchBytes = preparedList.reduce((sum, x) => sum + (x.sizeBytes || 0), 0);
      const batchFitsSinglePost = totalBatchBytes <= Math.floor(limitBytes * 0.88);
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
          const slideItems = preparedList.map((_, idx) => block.video(`attach://mv_dl_${idx}`));
          if (slideItems.length === 1) b.video('attach://mv_dl_0', preparedList[0].title);
          else b.slideshow(slideItems);
          b.divider();
        }

        b.table(
          preparedList.map((p, idx) => [
            `${start + idx + 1}.`,
            String(p.title).slice(0, 38),
            `${Math.max(1, Math.round(p.sizeBytes / (1024 * 1024)))} MB${p.durationSeconds ? ` · ${durationText(p.durationSeconds)}` : ''}`
          ]),
          { striped: true, bordered: true, compact: true }
        );

        if (failedTitles.length) {
          b.blockquote(rt.text(`⚠️ Skipped: ${failedTitles.slice(0, 3).join(' | ')}`));
        }

        b.paragraph(rt.italic(`🤖 Lancy Music (@${botUsername}) · High-Capacity Slide Delivery`));
        if (navRow.length) b.buttons(navRow);
        const actionRow = [];
        if (streamPageCallback) actionRow.push(richButton.callback('📺 Stream This Slide in VC', streamPageCallback(safePage), { style: 'success' }));
        if (backCallback) actionRow.push(richButton.callback('« Back to Episodes', backCallback()));
        if (actionRow.length) b.buttons(actionRow);
        b.validate();
        return b.toJSON();
      };

      if (batchFitsSinglePost && !spoiler) {
        const files = {};
        preparedList.forEach((p, idx) => {
          files[`mv_dl_${idx}`] = {
            filePath: p.filePath,
            filename: p.filename,
            contentType: 'video/mp4'
          };
        });
        const rich = buildAlbumCard(true);
        const prevMsgId = ms.dlMessageId || (ctx.query?.message?.message_id);
        let sent = null;
        if (prevMsgId && typeof api.editMessageRich === 'function') {
          try {
            sent = await api.editMessageRich(ctx.chatId, prevMsgId, rich, {}, files);
          } catch {
            sent = null;
          }
        }
        if (!sent) {
          sent = await api.sendRichMessage(ctx.chatId, rich, {}, files);
          if (prevMsgId && sent?.message_id && prevMsgId !== sent.message_id) {
            await api.deleteMessage(ctx.chatId, prevMsgId).catch(() => {});
          }
        }
        const msgId = sent?.message_id || prevMsgId;
        if (msgId) {
          this.app?.movieSessions?.registerMessage?.(ms, msgId, 'dl');
          ctx.controller?.markMediaDeliveryMessage?.(msgId);
          this.app?.telegram?.markMediaDeliveryMessage?.(msgId);
        }
        return { ok: true, messageId: msgId, count: preparedList.length };
      }

      // Large multi-file batch: chunk sendMediaGroup(s) so each HTTP upload stays safely under limit, then 1 clean slide controller
      onProgress?.(`📤 Sending ${preparedList.length} full HD files cleanly…`);
      let currentGroup = [];
      let currentGroupBytes = 0;
      const groups = [];
      for (const p of preparedList) {
        if (currentGroup.length >= 10 || (currentGroup.length > 0 && currentGroupBytes + p.sizeBytes > limitBytes)) {
          groups.push(currentGroup);
          currentGroup = [];
          currentGroupBytes = 0;
        }
        currentGroup.push(p);
        currentGroupBytes += p.sizeBytes;
      }
      if (currentGroup.length) groups.push(currentGroup);

      for (const grp of groups) {
        const grpFiles = {};
        const mediaArr = grp.map((p, idx) => {
          const field = `grp_${idx}`;
          grpFiles[field] = { filePath: p.filePath, filename: p.filename, contentType: 'video/mp4' };
          return {
            type: 'video',
            media: `attach://${field}`,
            caption: idx === 0 ? `🎬 <b>${escapeHtml(p.title)}</b> (Album ${safePage + 1}/${totalPages})` : `🎬 <b>${escapeHtml(p.title)}</b>`,
            parse_mode: 'HTML',
            supports_streaming: true,
            ...(p.durationSeconds ? { duration: p.durationSeconds } : {}),
            ...(spoiler ? { has_spoiler: true } : {})
          };
        });
        if (mediaArr.length === 1) {
          const sole = grp[0];
          await api.sendVideo(ctx.chatId, { filePath: sole.filePath, filename: sole.filename, contentType: 'video/mp4' }, {
            caption: mediaArr[0].caption,
            parse_mode: 'HTML',
            supports_streaming: true,
            ...(sole.durationSeconds ? { duration: sole.durationSeconds } : {}),
            ...(spoiler ? { has_spoiler: true } : {})
          });
        } else {
          await api.sendMediaGroup(ctx.chatId, mediaArr, {}, grpFiles);
        }
      }

      const navCard = buildAlbumCard(false);
      const oldNavId = ms.dlMessageId;
      const navSent = await api.sendRichMessage(ctx.chatId, navCard);
      if (oldNavId && navSent?.message_id && oldNavId !== navSent.message_id) {
        await api.deleteMessage(ctx.chatId, oldNavId).catch(() => {});
      }
      if (navSent?.message_id) {
        this.app?.movieSessions?.registerMessage?.(ms, navSent.message_id, 'dl');
      }
      return { ok: true, messageId: navSent?.message_id, count: preparedList.length };
    } finally {
      for (const p of preparedList) p.cleanup();
    }
  }
}
