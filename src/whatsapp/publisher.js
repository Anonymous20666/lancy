import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { splitIntoPacks, applySplitPlan, physicalPackName } from './split.js';
import { withRetry } from '../utils/retry.js';
import { sleep } from '../utils/time.js';
import sharp from 'sharp';
import { isWebPBuffer, isAnimatedWebP, isVideoBuffer, toWhatsAppSticker, resolveFfmpegPath } from '../media/convert.js';
import { formatPackTitle, toWhatsAppPackTitle, extractTelegramPackName } from '../stickers/packNaming.js';

/** Sanitize WhatsApp sticker pack name to avoid multiline promo captions becoming pack titles */
export function sanitizeWhatsAppPackName(title, fallback = 'Sticker Pack') {
  if (!title) return fallback;
  let t = String(title).trim();
  // Strip promo URLs or footer promo banners
  if (t.includes('𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘') || t.includes('http') || t.includes('t.me/')) {
    if (t.includes(' - ')) {
      const parts = t.split(' - ');
      const candidate = parts[parts.length - 1].split('\n')[0].trim();
      if (candidate && candidate.length <= 40) {
        return candidate.replace(/^[𓆩♡𓆪\s]+/, '').replace(/[𓆩♡𓆪\s]+$/, '').trim() || fallback;
      }
    }
    return fallback;
  }
  // Preserve aesthetic 3-part pack titles (user's signature symbols)
  if (t.includes('🌸') || t.includes('ʟᴀɴᴄʏ') || t.includes('♥︎') || t.includes('🌷') || t.includes('xɪᴛᴛʟᴇ')) {
    return t;
  }
  // Plain multiline paragraphs without delimiter are captions, use fallback
  if (t.includes('\n') || t.includes('\r')) {
    if (t.includes(' - ')) {
      const parts = t.split(' - ');
      const candidate = parts[parts.length - 1].split('\n')[0].trim();
      if (candidate && candidate.length <= 40) {
        return candidate.replace(/^[𓆩♡𓆪\s]+/, '').replace(/[𓆩♡𓆪\s]+$/, '').trim() || fallback;
      }
    }
    return fallback;
  }
  if (t.includes(' - ')) {
    const parts = t.split(' - ');
    t = parts[parts.length - 1].trim();
  }
  t = t.replace(/^[𓆩♡𓆪\s]+/, '').replace(/[𓆩♡𓆪\s]+$/, '').trim();
  if (t.length > 50) t = t.slice(0, 50).trim();
  return t || fallback;
}

/**
 * WhatsAppPublisher — turns logical Telegram sticker packs into WhatsApp
 * publications:
 *
 *   logical pack (N stickers)
 *     → split into physical packs of ≤ whatsapp.physicalStickerPackLimit
 *       (plogme enforces 60 — verified in its source)
 *     → for each selected session × channel:
 *         revalidate channel permission (never trust the cache)
 *         send pack(s) with the rendered caption
 *     → per-pack, per-channel error handling with retry/skip
 *
 * Emits progress events so the Telegram UI can render ONE live message.
 * The Telegram event loop is never blocked — this runs inside the
 * whatsapp queue as a job.
 */
/**
 * Mandatory WhatsApp sticker buffer validation.
 * Verifies non-empty buffer, valid WebP RIFF header, <= 500 KB, and decodable 512x512 dimensions.
 */
export async function validateWhatsAppStickerBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error('Sticker buffer is empty or invalid');
  }
  if (!isWebPBuffer(buf)) {
    throw new Error('Sticker buffer is not a valid WebP');
  }
  if (buf.length > 500 * 1024) {
    throw new Error(`Sticker exceeds 500 KB (${(buf.length / 1024).toFixed(1)} KB)`);
  }
  const meta = await sharp(buf, { failOn: 'none', page: 0 }).metadata();
  if (!meta.width || !meta.height) {
    throw new Error('Sticker buffer cannot be decoded or lacks dimensions');
  }
  if (meta.width !== 512 || meta.height !== 512) {
    throw new Error(`Sticker dimensions are ${meta.width}x${meta.height}, expected 512x512`);
  }
  return true;
}

export class WhatsAppPublisher extends EventEmitter {
  constructor({ db, settings, channels, captions, telegramApi, log } = {}) {
    super();
    this.db = db;
    this.settings = settings;
    this.channels = channels;
    this.captions = captions ?? null;
    this.telegramApi = telegramApi ?? null;
    this.log = log ?? logger().child({ module: 'wa-publisher' });
  }

  /**
   * Convert a Telegram sticker pack to WhatsApp stickers using the Telegram Bot API CDN (.tg pipeline).
   * @param {string} shortNameOrUrl Telegram pack shortName or https://t.me/addstickers/... link
   * @param {object} opts { telegramApi, getStickerBytes, packId, onProgress }
   */
  async convertTelegramPack(shortNameOrUrl, { telegramApi, getStickerBytes, packId, totalStickers, onProgress } = {}) {
    const api = telegramApi ?? this.telegramApi;
    const shortName = extractTelegramPackName(shortNameOrUrl);
    let tgSet = null;

    if (api && shortName) {
      try {
        tgSet = await api.getStickerSet(shortName);
        this.log.info({ shortName, count: tgSet?.stickers?.length }, 'using .tg method: downloaded telegram sticker set');
      } catch (err) {
        this.log.warn({ err: err?.message, shortName }, 'failed to fetch telegram set, falling back to getStickerBytes');
      }
    }

    const title = tgSet?.title || shortName || 'Sticker Pack';
    const totalCount = tgSet?.stickers?.length ?? 0;
    const hasVideo = tgSet?.stickers?.some((s) => s.is_video || s.type === 'video') ?? false;
    const hasAnimated = tgSet?.stickers?.some((s) => s.is_animated || s.type === 'animated') ?? false;
    const ffmpegPath = resolveFfmpegPath(this.settings?.get('media.ffmpegPath') ?? '');

    const stickers = [];
    if (tgSet?.stickers?.length) {
      const concurrency = 4;
      for (let i = 0; i < tgSet.stickers.length; i += concurrency) {
        const chunk = tgSet.stickers.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map(async (st) => {
          let lastErr = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              let fileId = st.file_id;
              // For animated .tgs (Lottie), download static thumbnail so it converts cleanly
              if (st.is_animated && (st.thumbnail || st.thumb)) {
                fileId = (st.thumbnail || st.thumb).file_id;
              }
              const file = await api.getFile(fileId);
              const rawBuffer = await api.downloadFile(file.file_path);
              if (!rawBuffer || rawBuffer.length === 0) {
                throw new Error('Downloaded buffer is empty');
              }
              const convertedWebp = await toWhatsAppSticker(rawBuffer, { configuredFfmpeg: ffmpegPath });
              await validateWhatsAppStickerBuffer(convertedWebp);
              return {
                buffer: convertedWebp,
                emoji: st.emoji ? [st.emoji] : ['🤍']
              };
            } catch (err) {
              lastErr = err;
              if (attempt < 3) await sleep(250);
            }
          }
          this.log.warn({ err: lastErr?.message, fileId: st?.file_id }, 'failed to convert sticker from TG pack after 3 attempts');
          return null;
        }));

        for (const res of chunkResults) {
          if (res) stickers.push(res);
        }
        onProgress?.({ converted: stickers.length, total: totalCount });
      }
    } else if (getStickerBytes && packId != null) {
      // Local database fallback (used by tests or when Telegram API is unavailable)
      const count = Number(totalStickers || totalCount || 60);
      for (let i = 0; i < count; i++) {
        try {
          const raw = await getStickerBytes(packId, i);
          if (!raw) break;
          let buf = raw;
          try {
            const converted = await toWhatsAppSticker(raw, { configuredFfmpeg: ffmpegPath });
            await validateWhatsAppStickerBuffer(converted);
            buf = converted;
          } catch {}
          stickers.push({ buffer: buf, emoji: ['🤍'] });
        } catch (err) {
          this.log.warn({ err: err?.message, packId, index: i }, 'local sticker conversion failed');
        }
      }
    }

    return {
      title,
      shortName,
      stickers,
      hasVideo,
      hasAnimated,
      isAnimatedPack: hasVideo || hasAnimated || stickers.some((s) => isAnimatedWebP(s.buffer))
    };
  }

  /**
   * Build the full publish plan (pure — used by the preview screen AND the
   * executor, so preview and execution can never disagree).
   */
  buildPlan({ userId = 0, packs, sessionId, channelJids, caption, customPackName = null, limit: explicitLimit = null }) {
    const defaultLimit = explicitLimit ? Number(explicitLimit) : Number(this.settings?.getForUser?.(userId, 'whatsapp.physicalStickerPackLimit') ?? this.settings?.get('whatsapp.physicalStickerPackLimit') ?? 60);
    const perPack = [];
    for (const pack of packs) {
      const isVideo = pack.sticker_type === 'video' || pack.type === 'video';
      const limit = isVideo ? Math.min(defaultLimit, 30) : defaultLimit;
      const stickerCount = Number(pack.stickerCount ?? pack.count ?? pack.sticker_count ?? 0);
      const rawTitle = pack.customTitle ?? customPackName ?? pack.title ?? pack.tgTitle ?? pack.tg_title ?? pack.name ?? 'Sticker Pack';
      const title = sanitizeWhatsAppPackName(rawTitle);
      const splits = splitIntoPacks(stickerCount, limit);
      perPack.push({
        pack: { ...pack, title },
        limit,
        physicalPacks: splits.map((s) => ({
          ...s,
          name: physicalPackName(title, s.index, splits.length),
          stickerCount: s.count
        })),
        physicalCount: splits.length
      });
    }
    return {
      userId,
      packs: perPack,
      sessionId,
      channelJids: [...channelJids],
      caption,
      customPackName,
      totals: {
        logicalPacks: packs.length,
        physicalPacks: perPack.reduce((n, p) => n + p.physicalCount, 0),
        stickers: packs.reduce((n, p) => n + Number(p.stickerCount ?? p.count ?? p.sticker_count ?? 0), 0),
        destinations: channelJids.length
      }
    };
  }

  /**
   * Execute a publish plan.
   * @param {object} opts { plan, session, telegramApi, getStickerBytes(packId, index) → Buffer, signal, onProgress }
   */
  async publish({ plan, session, telegramApi, getStickerBytes, signal, onProgress } = {}) {
    const { packs, sessionId, channelJids, caption } = plan;
    if (!session?.isOnline) {
      throw new LancyError('♡ That WhatsApp session is not connected right now.', { code: 'SESSION_OFFLINE' });
    }

    // 1. Revalidate channel permissions — never trust the cache.
    onProgress?.({ stage: 'validating', channelJids });
    const revalidation = await this.channels.revalidate(session, channelJids);
    const targets = revalidation.map((r) => ({
      jid: r.jid,
      name: r.name,
      canPublish: r.canPublish,
      status: 'pending'
    }));
    this.emit('channelsValidated', targets);

    // 2. Persist the publication.
    const publicationId = this.#createPublication(plan);
    const results = {
      publicationId,
      sessionId,
      caption,
      packs: [],
      targets,
      totals: { ...plan.totals, succeeded: 0, failed: 0, skipped: 0 }
    };

    const retryCount = this.settings?.get('whatsapp.retryCount') ?? 3;
    const delayBetween = this.settings?.get('whatsapp.publishingDelayMs') ?? 1200;
    const api = telegramApi ?? this.telegramApi;
    const ffmpegPath = resolveFfmpegPath(this.settings?.get('media.ffmpegPath') ?? '');
    const sampleLimit = Math.min(5, Math.max(2, Number(this.settings?.get('whatsapp.sampleStickersCount') ?? 3)));

    for (let pIdx = 0; pIdx < packs.length; pIdx++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const packPlan = packs[pIdx];
      const title = packPlan.pack.title ?? packPlan.pack.tgTitle ?? packPlan.pack.tg_title ?? packPlan.pack.name ?? 'Sticker Pack';
      const stickerCount = Number(packPlan.pack.stickerCount ?? packPlan.pack.count ?? packPlan.pack.sticker_count ?? 0);
      const packResult = {
        packId: packPlan.pack.id,
        title,
        stickerCount,
        physicalPacks: [],
        status: 'pending'
      };
      results.packs.push(packResult);

      onProgress?.({ stage: 'preparing', pack: packResult.title, packIndex: pIdx + 1, totalPacks: packs.length });

      // 1. Convert stickers using the unified .tg pipeline
      let packShortName = packPlan.pack.tg_short_name ?? packPlan.pack.shortName ?? packPlan.pack.name ?? (packPlan.pack.link ? extractTelegramPackName(packPlan.pack.link) : null);
      if (!packShortName && packPlan.pack.id && this.db) {
        const row = this.db.get('SELECT tg_short_name, link FROM sticker_packs WHERE id = ?', packPlan.pack.id);
        if (row?.tg_short_name) packShortName = row.tg_short_name;
        else if (row?.link) packShortName = extractTelegramPackName(row.link);
      }
      let convertedPack = null;
      try {
        const expectedTotal = packPlan.physicalPacks.reduce((n, p) => n + p.count, 0) || stickerCount;
        convertedPack = await this.convertTelegramPack(packShortName, {
          telegramApi: api,
          getStickerBytes: getStickerBytes ? ((pid, idx) => getStickerBytes(pid ?? packPlan.pack.id, idx)) : null,
          packId: packPlan.pack.id,
          totalStickers: expectedTotal,
          onProgress: (p) => onProgress?.({ stage: 'converting', pack: packResult.title, ...p })
        });
      } catch (convErr) {
        this.log.warn({ err: convErr?.message, pack: title }, 'convertTelegramPack error');
      }

      let allStickers = convertedPack?.stickers ?? [];

      // Fallback: if convertTelegramPack returned no stickers but getStickerBytes exists (e.g. tests)
      if (allStickers.length === 0 && getStickerBytes && packPlan.pack.id != null) {
        const physicalTotal = packPlan.physicalPacks.reduce((n, p) => n + p.count, 0) || stickerCount;
        for (let i = 0; i < physicalTotal; i++) {
          try {
            const raw = await getStickerBytes(packPlan.pack.id, i);
            if (!raw) break;
            allStickers.push({ buffer: raw, emoji: ['🤍'] });
          } catch {
            break;
          }
        }
      }

      if (allStickers.length === 0) {
        throw new LancyError(`♡ Sticker pack "${packResult.title}" has no valid convertible stickers.`, { code: 'STICKER_MISSING' });
      }

      // 2. Generate preview (video or image) for this pack's announcement
      let previewImage = null;
      let previewVideo = null;
      try {
        const firstBytes = allStickers[0]?.buffer;
        if (firstBytes && Buffer.isBuffer(firstBytes)) {
          if (isVideoBuffer(firstBytes)) {
            if (ffmpegPath) {
              const dir = mkdtempSync(join(tmpdir(), 'lancy-prev-'));
              try {
                const inPath = join(dir, 'in.bin');
                const outVidPath = join(dir, 'preview.mp4');
                const outJpgPath = join(dir, 'frame.jpg');
                writeFileSync(inPath, firstBytes);

                // Convert video sticker (WebM/video) into clean, looping MP4 video preview
                try {
                  execFileSync(ffmpegPath, [
                    '-y', '-i', inPath,
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart',
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black',
                    '-t', '10',
                    outVidPath
                  ], { stdio: 'ignore' });
                  if (existsSync(outVidPath) && statSync(outVidPath).size > 0) {
                    previewVideo = readFileSync(outVidPath);
                  }
                } catch (vidErr) {
                  this.log.debug({ err: vidErr?.message }, 'ffmpeg preview.mp4 failed');
                }

                // Generate fallback static frame
                try {
                  execFileSync(ffmpegPath, [
                    '-y', '-i', inPath,
                    '-frames:v', '1',
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white',
                    '-q:v', '2',
                    outJpgPath
                  ], { stdio: 'ignore' });
                  if (existsSync(outJpgPath)) {
                    previewImage = readFileSync(outJpgPath);
                  }
                } catch {}
              } catch {} finally {
                rmSync(dir, { recursive: true, force: true });
              }
            }
          } else {
            previewImage = await sharp(firstBytes, { failOn: 'none', page: 0 })
              .flatten({ background: { r: 255, g: 255, b: 255 } })
              .resize(512, 512, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
              .jpeg({ quality: 90 })
              .toBuffer();
          }
        }
      } catch (prevErr) {
        this.log.warn({ err: prevErr?.message }, 'failed to generate preview for pack announcement');
      }

      // 3. Render distinct caption for THIS pack (custom caption for single pack, or per-pack aura caption)
      let packCaption = caption;
      if (packs.length > 1 || !packCaption) {
        const cleanTitle = sanitizeWhatsAppPackName(title);
        const character = (packPlan.pack.query || packPlan.pack.customTitle || title || 'Stickers')
          .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
          .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
          .trim() || 'Stickers';

        if (this.captions) {
          const vars = {
            query: packPlan.pack.query ?? character,
            title: cleanTitle,
            character,
            stickers: allStickers.length,
            packs: packPlan.physicalCount,
            packName: cleanTitle,
            telegramLink: packPlan.pack.link ?? (packShortName ? `https://t.me/addstickers/${packShortName}` : ''),
            sessionName: session?.name ?? ''
          };
          packCaption = this.captions.renderDefault(vars);
        } else if (packCaption) {
          packCaption = packCaption;
        } else {
          packCaption = `✦ ${cleanTitle} ✦\nStickers: ${allStickers.length}\n${packPlan.pack.link ?? ''}`;
        }
      }

      // 4. Send preview video/photo + caption for this pack to all active targets
      if (packCaption) {
        for (const target of targets) {
          if (target.canPublish === 'no') continue;
          onProgress?.({ stage: 'caption', pack: packResult.title, channel: target.jid, channelName: target.name });
          try {
            if (previewVideo && typeof session.sendVideo === 'function') {
              try {
                await withRetry(() => session.sendVideo(target.jid, previewVideo, packCaption), { attempts: retryCount });
                this.log.info({ sessionId, channel: target.jid, pack: title }, 'preview video with caption sent before sticker pack');
              } catch (vidErr) {
                this.log.warn({ err: vidErr, channel: target.jid }, 'sendVideo failed, trying sendImage or sendText');
                if (previewImage && typeof session.sendImage === 'function') {
                  await withRetry(() => session.sendImage(target.jid, previewImage, packCaption), { attempts: retryCount });
                } else {
                  await withRetry(() => session.sendText(target.jid, packCaption), { attempts: retryCount });
                }
              }
            } else if (previewImage && typeof session.sendImage === 'function') {
              try {
                await withRetry(() => session.sendImage(target.jid, previewImage, packCaption), { attempts: retryCount });
                this.log.info({ sessionId, channel: target.jid, pack: title }, 'preview photo with caption sent before sticker pack');
              } catch (imgErr) {
                this.log.warn({ err: imgErr, channel: target.jid }, 'sendImage failed, falling back to sendText');
                await withRetry(() => session.sendText(target.jid, packCaption), { attempts: retryCount });
              }
            } else {
              await withRetry(() => session.sendText(target.jid, packCaption), { attempts: retryCount });
              this.log.info({ sessionId, channel: target.jid, pack: title }, 'caption text sent before sticker pack');
            }
          } catch (error) {
            target.captionError = friendly(error);
            this.log.warn({ err: error, channel: target.jid }, 'caption send failed');
          }
          if (delayBetween > 0) await sleep(delayBetween);
        }
      }

      // 5. Send sample stickers for this pack (2 to 5 stickers)
      const sampleCount = Math.min(sampleLimit, allStickers.length);
      if (sampleCount > 0 && typeof session.sendSticker === 'function') {
        onProgress?.({ stage: 'sample_stickers', pack: packResult.title, count: sampleCount });
        for (let s = 0; s < sampleCount; s++) {
          const sampleSticker = allStickers[s];
          if (sampleSticker?.buffer && isWebPBuffer(sampleSticker.buffer)) {
            for (const target of targets) {
              if (target.canPublish === 'no') continue;
              await session.sendSticker(target.jid, sampleSticker.buffer).catch((err) => {
                this.log.warn({ err: err?.message, channel: target.jid, index: s }, 'sample sticker send skipped');
              });
              await sleep(800);
            }
          }
        }
      }

      // 6. Send physical sticker packs for this logical pack (Part 01, Part 02, etc.)
      for (const physical of packPlan.physicalPacks) {
        onProgress?.({ stage: 'preparing_pack', pack: packResult.title, physical: physical.index + 1, total: packPlan.physicalCount });
        const physicalResult = {
          index: physical.index,
          name: physical.name,
          stickerCount: physical.count,
          status: 'pending'
        };
        packResult.physicalPacks.push(physicalResult);
        const physicalRowId = this.#createPhysicalPack(publicationId, physical, packResult.title);

        // Slice stickers for this physical pack
        const physicalStickers = allStickers.slice(physical.start, physical.start + physical.count);
        if (physicalStickers.length === 0) {
          throw new LancyError(`♡ Sticker pack "${packResult.title}" (part ${physical.index + 1}) has no stickers.`, { code: 'STICKER_MISSING' });
        }

        // WhatsApp tray icon cover: 96x96 PNG derived from the first sticker of this physical pack
        let cover = null;
        try {
          if (isVideoBuffer(physicalStickers[0].buffer) && ffmpegPath) {
            const dir = mkdtempSync(join(tmpdir(), 'lancy-tray-'));
            try {
              const inP = join(dir, 'in.bin');
              const outP = join(dir, 'tray.png');
              writeFileSync(inP, physicalStickers[0].buffer);
              execFileSync(ffmpegPath, ['-y', '-i', inP, '-frames:v', '1', '-vf', 'scale=96:96:force_original_aspect_ratio=decrease,pad=96:96:(ow-iw)/2:(oh-ih)/2:color=black@0', outP], { stdio: 'ignore' });
              if (existsSync(outP)) cover = readFileSync(outP);
            } catch {} finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
          if (!cover) {
            cover = await sharp(physicalStickers[0].buffer, { failOn: 'none', page: 0 })
              .resize(96, 96, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
              .png()
              .toBuffer();
          }
        } catch {
          cover = await sharp({
            create: { width: 96, height: 96, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
          }).png().toBuffer();
        }

        for (const target of targets) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          onProgress?.({
            stage: 'sending',
            pack: packResult.title,
            physical: physical.index + 1,
            total: packPlan.physicalCount,
            channel: target.jid,
            channelName: target.name
          });
          if (target.canPublish === 'no') {
            target.status = 'skipped';
            target.error = 'no publishing permission';
            results.totals.skipped++;
            this.#updateTarget(publicationId, target);
            continue;
          }
          try {
            await withRetry(() => session.sendStickerPack(target.jid, {
              name: physical.name,
              publisher: this.settings?.getForUser?.(plan.userId, 'stickers.creatorName') ?? this.settings?.get('stickers.creatorName') ?? 'Lancy',
              description: `${physical.name} • ${physicalStickers.length} stickers`,
              cover,
              stickers: physicalStickers
            }), {
              attempts: retryCount,
              shouldRetry: (e) => e.retryable !== false && e.code !== 'SESSION_OFFLINE'
            });

            target.status = 'sent';
            target.sentAt = new Date().toISOString();
            physicalResult.status = 'sent';
            results.totals.succeeded++;
            this.log.info({ sessionId, channel: target.jid, pack: physical.name }, 'pack published');
          } catch (error) {
            target.status = 'failed';
            target.error = friendly(error);
            target.rawError = error?.message ?? String(error); // stack/details stay out of Telegram
            physicalResult.status = 'failed';
            physicalResult.error = target.error;
            physicalResult.rawError = target.rawError;
            results.totals.failed++;
            this.log.error({ err: error, sessionId, channel: target.jid, pack: physical.name }, 'pack publish failed');
          }
          this.#updateTarget(publicationId, target);
          if (delayBetween > 0) await sleep(delayBetween);
        }
        this.#updatePhysicalPack(physicalRowId, physicalResult);
        onProgress?.({ stage: 'packDone', pack: packResult.title, physical: physical.index + 1, total: packPlan.physicalCount });
      }
      packResult.status = packResult.physicalPacks.every((p) => p.status === 'sent') ? 'sent'
        : packResult.physicalPacks.some((p) => p.status === 'sent') ? 'partial' : 'failed';
    }

    const failed = results.totals.failed;
    const succeeded = results.totals.succeeded;
    const attempted = succeeded + failed;
    this.#finishPublication(publicationId, failed === 0 ? 'done' : (succeeded > 0 ? 'partial' : 'failed'));
    results.status = failed === 0 ? 'done' : (succeeded > 0 ? 'partial' : 'failed');
    results.totals.attempted = attempted;
    onProgress?.({ stage: 'done', results });
    this.emit('done', results);
    return results;
  }

  #createPublication(plan) {
    let packId = plan.packs[0]?.pack.id ?? null;
    if (packId) {
      const exists = this.db.get('SELECT id FROM sticker_packs WHERE id = ?', packId);
      if (!exists) packId = null;
    }
    const row = this.db.run(
      `INSERT INTO wa_publications
         (user_id, pack_id, session_id, caption, stickers_total, packs_total, status, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, 'publishing', ?)`,
      plan.userId ?? plan.packs[0]?.pack?.userId ?? 0,
      packId,
      plan.sessionId,
      plan.caption ?? null,
      plan.totals.stickers,
      plan.totals.physicalPacks,
      JSON.stringify({ packIds: plan.packs.map((p) => p.pack.id), logicalPacks: plan.totals.logicalPacks })
    );
    const publicationId = Number(row.lastInsertRowid);
    for (const target of plan.channelJids) {
      this.db.run(
        'INSERT INTO wa_publication_targets (publication_id, channel_jid) VALUES (?, ?)',
        publicationId, target
      );
    }
    return publicationId;
  }

  #createPhysicalPack(publicationId, physical, title) {
    const row = this.db.run(
      `INSERT INTO wa_physical_packs (publication_id, pack_index, sticker_count, name, status)
       VALUES (?, ?, ?, ?, 'sending')`,
      publicationId, physical.index, physical.count, physical.name ?? title
    );
    return Number(row.lastInsertRowid);
  }

  #updatePhysicalPack(id, result) {
    this.db.run(
      `UPDATE wa_physical_packs SET status = ?, error = ?, sent_at = ? WHERE id = ?`,
      result.status, result.error ?? null, result.status === 'sent' ? new Date().toISOString() : null, id
    );
  }

  #updateTarget(publicationId, target) {
    this.db.run(
      `UPDATE wa_publication_targets SET status = ?, error = ?, sent_at = ?
       WHERE publication_id = ? AND channel_jid = ?`,
      target.status, target.error ?? target.captionError ?? null,
      target.sentAt ?? null, publicationId, target.jid
    );
  }

  #finishPublication(id, status) {
    this.db.run(
      `UPDATE wa_publications SET status = ?, finished_at = datetime('now') WHERE id = ?`,
      status, id
    );
  }
}

function friendly(error) {
  if (error?.code === 'SESSION_OFFLINE') return 'session went offline';
  const msg = String(error?.message ?? error);
  if (/rate|limit/i.test(msg)) return 'WhatsApp rate limit — retry later';
  if (/not-authorized|forbidden/i.test(msg)) return 'not authorized to post there';
  if (/media upload|upload/i.test(msg)) return 'media upload failed';
  return msg.length > 120 ? msg.slice(0, 119) + '…' : msg;
}
