import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { resolveLimits, validateShortName, validateTitle, remainingCapacity } from './limits.js';
import { toTelegramStaticSticker, toTelegramVideoSticker, toThumbnail } from '../media/convert.js';
import { emojisForSticker } from './emoji.js';
import { withRetry } from '../utils/retry.js';
import { sleep } from '../utils/time.js';

/**
 * TelegramStickerService — creates and manages bot-owned sticker packs via
 * the current Bot API:
 *
 *   createNewStickerSet  → creates the set with 1..N initial stickers
 *   addStickerToSet      → adds ONE sticker per call (never batches 120)
 *   setStickerSetThumbnail → pack thumbnail
 *   getStickerSet        → live cross-check of count/limits
 *
 * All platform limits come from settings (resolveLimits) and are
 * cross-checked against the live set where possible.
 */
export class TelegramStickerService {
  constructor({ api, db, settings, log } = {}) {
    this.api = api;
    this.db = db;
    this.settings = settings;
    this.log = log ?? logger().child({ module: 'tg-stickers' });
  }

  #botUsername() {
    return this.api.botUsername || 'lancybot';
  }

  /** Convert a media descriptor into sticker bytes for Telegram. */
  async convertForTelegram(descriptor, { type = 'static' } = {}) {
    if (type === 'video') {
      return toTelegramVideoSticker(descriptor.buffer, {
        maxBytes: resolveLimits(this.settings, 'video').maxBytes,
        maxDuration: Math.min(3, Math.max(1, Number(this.settings?.get('stickers.videoMaxDurationSeconds')) || 3)),
        configuredFfmpeg: this.settings?.get('media.ffmpegPath') ?? ''
      });
    }
    return toTelegramStaticSticker(descriptor.buffer, {
      maxBytes: resolveLimits(this.settings, 'static').maxBytes,
      quality: this.settings?.get('stickers.imageProcessingQuality') ?? 92
    });
  }

  /**
   * Create a pack from prepared sticker items.
   * @param {object} opts
   * @param {number} opts.userId Telegram user ID (set owner)
   * @param {string} opts.title pack title
   * @param {string} opts.shortName full short name incl. _by_<bot>
   * @param {Array} opts.items [{ buffer, emoji, type, sha256, phash, sourcePinId }]
   * @param {string} [opts.query] original search
   * @param {string} [opts.stickerType] 'static' | 'video'
   * @param {boolean} [opts.thumbnail] upload first item as thumbnail
   * @param {(info) => void} [opts.onProgress]
   */
  async createPack({ userId, title, shortName, items, query = null, stickerType = 'static', thumbnail = true, onProgress }) {
    if (!items?.length) throw new LancyError('♡ There are no stickers to put in a pack.', { code: 'NO_ITEMS' });
    const limits = resolveLimits(this.settings, stickerType === 'video' ? 'video' : 'static');
    if (items.length > limits.perSet) {
      throw new LancyError(
        `♡ Telegram ${stickerType} packs hold up to ${limits.perSet} stickers — you asked for ${items.length}. I can split it into multiple packs ♡`,
        { code: 'TOO_MANY' }
      );
    }
    const name = validateShortName(shortName, this.#botUsername());
    const cleanTitle = validateTitle(title);
    const typeLabel = stickerType === 'video' ? 'video' : 'static';

    const initialCount = Math.min(items.length, limits.createInitialLimit);
    const initial = items.slice(0, initialCount);
    const rest = items.slice(initialCount);

    const inputSticker = (item) => {
      const rawEmojis = (item.emoji?.length ? item.emoji : ['🤍']).map((e) => (e === '♡' ? '🤍' : e));
      const validEmojis = rawEmojis.filter(Boolean);
      return {
        sticker: { buffer: item.buffer, filename: `sticker.${typeLabel === 'video' ? 'webm' : 'webp'}` },
        format: typeLabel,
        emoji_list: validEmojis.length ? validEmojis : ['🤍']
      };
    };

    onProgress?.({ stage: 'creating', done: 0, total: items.length });
    let created;
    try {
      created = await withRetry(() =>
        this.api.createNewStickerSet({
          userId,
          name,
          title: cleanTitle,
          stickers: initial.map(inputSticker),
          stickerType: 'regular'
        }), { attempts: 2 });
    } catch (error) {
      throw this.#friendlyStickerError(error, 'create the pack');
    }
    if (!created) throw new LancyError('♡ Telegram refused to create the pack.', { code: 'CREATE_FAILED' });

    // Thumbnail (optional, best effort — never fails the pack).
    if (thumbnail && initial[0]?.buffer) {
      try {
        const thumb = stickerType === 'video'
          ? initial[0].buffer // video thumbs need a static frame; skip for video packs
          : (await toThumbnail(initial[0].buffer)).buffer;
        if (stickerType !== 'video') {
          await this.api.setStickerSetThumbnail({ name, userId, thumbnail: { buffer: thumb, filename: 'thumb.webp' } }).catch(() => {});
        }
      } catch { /* thumbnail is cosmetic */ }
    }

    // Add the rest one by one, with gentle pacing and live progress.
    let done = initial.length;
    for (const item of rest) {
      let added = false;
      try {
        await withRetry(() => this.api.addStickerToSet({ userId, name, sticker: inputSticker(item) }), {
          attempts: 2,
          onRetry: () => onProgress?.({ stage: 'adding', done, total: items.length })
        });
        added = true;
      } catch (error) {
        this.log?.warn?.({ err: error?.message, done }, 'addStickerToSet failed, retrying with fallback emoji');
        try {
          const fallback = { ...inputSticker(item), emoji_list: ['🤍'] };
          await this.api.addStickerToSet({ userId, name, sticker: fallback });
          added = true;
        } catch (fbErr) {
          this.log?.warn?.({ err: fbErr?.message, done }, 'skipped unaddable sticker item');
        }
      }
      if (added) done++;
      onProgress?.({ stage: 'adding', done, total: items.length });
      const delay = this.settings?.get('telegram.stickerAddDelayMs') ?? 250;
      if (delay > 0) await sleep(delay);
    }

    // Live cross-check of the final count.
    let liveCount = done;
    try {
      const set = await this.api.getStickerSet(name);
      liveCount = set?.stickers?.length ?? done;
    } catch { /* keep local count */ }

    onProgress?.({ stage: 'done', done, total: items.length });
    return {
      name,
      title: cleanTitle,
      count: liveCount,
      link: `https://t.me/addstickers/${name}`,
      stickerType: typeLabel
    };
  }

  /** Add stickers to an EXISTING bot-owned pack (with live capacity check). */
  async addToPack({ userId, shortName, items, stickerType = 'static', onProgress }) {
    const name = validateShortName(shortName, this.#botUsername());
    let currentCount = 0;
    try {
      const set = await this.api.getStickerSet(name);
      currentCount = set?.stickers?.length ?? 0;
    } catch (error) {
      throw this.#friendlyStickerError(error, 'open that pack');
    }
    const limits = resolveLimits(this.settings, stickerType === 'video' ? 'video' : 'static');
    const capacity = remainingCapacity(currentCount, limits.perSet);
    if (capacity <= 0) {
      throw new LancyError(`♡ That pack is already full (${limits.perSet} stickers).`, { code: 'PACK_FULL' });
    }
    const usable = items.slice(0, capacity);
    if (usable.length < items.length) {
      this.log.warn({ name, requested: items.length, capacity }, 'pack capacity limited the add');
    }
    let done = 0;
    for (const item of usable) {
      try {
        const rawEmojis = (item.emoji?.length ? item.emoji : ['🤍']).map((e) => (e === '♡' ? '🤍' : e));
        const validEmojis = rawEmojis.filter(Boolean);
        await this.api.addStickerToSet({
          userId,
          name,
          sticker: {
            sticker: { buffer: item.buffer, filename: `sticker.${stickerType === 'video' ? 'webm' : 'webp'}` },
            format: stickerType === 'video' ? 'video' : 'static',
            emoji_list: validEmojis.length ? validEmojis : ['🤍']
          }
        });
      } catch (error) {
        throw this.#friendlyStickerError(error, `add sticker ${done + 1}`);
      }
      done++;
      onProgress?.({ stage: 'adding', done, total: usable.length });
      const delay = this.settings?.get('telegram.stickerAddDelayMs') ?? 250;
      if (delay > 0) await sleep(delay);
    }
    return { name, added: done, count: currentCount + done, capacity };
  }

  /** Fetch a pack's live sticker file_ids (for WhatsApp publishing). */
  async getPackStickers(shortName) {
    const set = await this.api.getStickerSet(validateShortName(shortName, this.#botUsername()));
    return (set?.stickers ?? []).map((s) => ({
      fileId: s.file_id,
      emoji: s.emoji ?? null,
      isVideo: s.type === 'video' || (s.type === 'regular' && s.is_video),
      isAnimated: s.type === 'animated',
      width: s.width,
      height: s.height
    }));
  }

  /** Download sticker bytes by file_id (for WhatsApp publishing). */
  async downloadSticker(fileId) {
    const file = await this.api.getFile(fileId);
    return this.api.downloadFile(file.file_path);
  }

  #friendlyStickerError(error, action) {
    const desc = String(error?.description ?? error?.message ?? error);
    if (/STICKERSET_INVALID/.test(desc)) {
      return new LancyError('♡ That pack does not exist or was not created by me.', { code: 'STICKERSET_INVALID', cause: error });
    }
    if (/STICKERS_TOO_MUCH/.test(desc)) {
      return new LancyError('♡ That pack reached Telegram\'s sticker limit.', { code: 'STICKERS_TOO_MUCH', cause: error });
    }
    if (/STICKER_PNG_DIMENSIONS|STICKER_VIDEO_/.test(desc) || /dimensions/.test(desc)) {
      return new LancyError('♡ Telegram rejected a sticker\'s dimensions — the source media may be too unusual.', { code: 'DIMENSIONS', cause: error });
    }
    if (/STICKER_FILE_INVALID|FILE_INVALID|too big|FILE_TOO_BIG/.test(desc)) {
      return new LancyError('♡ Telegram rejected a sticker file — it may be corrupt or too large.', { code: 'FILE_INVALID', cause: error });
    }
    if (/STICKER_EMOJI_INVALID/.test(desc)) {
      return new LancyError('♡ Telegram did not like the emoji assigned to a sticker.', { code: 'EMOJI', cause: error });
    }
    if (/name is already occupied|STICKER_SET_NAME_OCCUPIED|taken/.test(desc)) {
      return new LancyError('♡ That pack name is taken — I will pick another one ♡', { code: 'NAME_TAKEN', cause: error, retryable: true });
    }
    if (/need administrator rights|not enough rights/.test(desc)) {
      return new LancyError('♡ I need permission to manage that pack.', { code: 'RIGHTS', cause: error });
    }
    return LancyError.wrap(error, `♡ Something went wrong while trying to ${action}.`);
  }
}

/** Prepare sticker items from media descriptors (conversion + emoji). */
export async function prepareStickerItems(descriptors, { stickerService, query = '', stickerType = 'static', onProgress } = {}) {
  const assignment = stickerService.settings?.get('stickers.emojiAssignment') ?? 'auto';
  const rawPackEmoji = stickerService.settings?.get('stickers.packEmoji') ?? '🤍';
  const packEmoji = rawPackEmoji === '♡' ? '🤍' : rawPackEmoji;
  const items = [];
  let done = 0;
  for (const descriptor of descriptors) {
    const converted = await stickerService.convertForTelegram(descriptor, { type: stickerType });
    const rawEmoji = (Array.isArray(descriptor.emoji) && descriptor.emoji.length)
      ? descriptor.emoji
      : (descriptor.emoji ? [descriptor.emoji] : emojisForSticker({ query, packEmoji, index: done, assignment }));
    const emoji = rawEmoji.map((e) => (e === '♡' ? '🤍' : e)).filter(Boolean);
    items.push({
      buffer: converted.buffer,
      emoji,
      type: stickerType,
      sha256: descriptor.sha256,
      phash: descriptor.phash,
      sourcePinId: descriptor.pinId ?? null,
      width: converted.width ?? 512,
      height: converted.height ?? 512
    });
    done++;
    onProgress?.({ stage: 'converting', done, total: descriptors.length });
  }
  return items;
}
