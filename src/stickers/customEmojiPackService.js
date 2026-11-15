import { cpus } from 'node:os';
import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { withRetry } from '../utils/retry.js';
import { sleep } from '../utils/time.js';
import { buildShortName, cleanTgTitle, resolveLimits, validateTitle } from './limits.js';
import { toCustomEmojiAsset, toRegularStickerFromEmoji } from './emojiConverter.js';
import { toTelegramStaticSticker, toTelegramVideoSticker, toThumbnail } from '../media/convert.js';
import { extractCleanStickerName, extractTelegramPackName } from './packNaming.js';
import { emojisForSticker } from './emoji.js';

/** Execute tasks over an array with a rolling bounded worker pool, preserving item order. */
async function runBounded(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency || 1, list.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= list.length) break;
        try {
          results[idx] = { status: 'fulfilled', value: await worker(list[idx], idx) };
        } catch (reason) {
          results[idx] = { status: 'rejected', reason };
        }
      }
    })
  );
  return results;
}

/**
 * CustomEmojiPackService — dedicated orchestration for Telegram Custom Emoji sets
 * (sticker_type: 'custom_emoji', 200 items/set, mixed static/video/animated support),
 * plus pack merge, clone+rename, live retitling, item deletion, and cross-kind
 * conversion between Custom Emoji packs and Regular Sticker packs.
 */
export class CustomEmojiPackService {
  constructor({ api, db, settings, stickerService, packService, media, mediaWorkerPool, customEmojiRegistry = null, log } = {}) {
    this.api = api;
    this.db = db;
    this.settings = settings;
    this.stickerService = stickerService;
    this.packService = packService;
    this.media = media;
    this.mediaWorkerPool = mediaWorkerPool;
    this.customEmojiRegistry = customEmojiRegistry;
    this.log = log ?? logger().child({ module: 'custom-emoji-packs' });
  }

  #botUsername() {
    return this.api?.botUsername || this.settings?.get('general.botUsername') || 'lancybot';
  }

  /**
   * Resolve effective pack title using hierarchy:
   *   1. Explicit override passed by user for this pack
   *   2. User personal override (`user_settings` via settings.getForUser)
   *   3. Owner global default (`bot_settings` settings.customEmoji.defaultPackName)
   *   4. Clean fallback (`Lancy Custom Emojis`)
   */
  resolveEffectivePackName(userId, overrideTitle = null, { fallbackQuery = '' } = {}) {
    const explicit = String(overrideTitle ?? '').trim();
    const userOrGlobal = this.settings?.getForUser?.(userId, 'customEmoji.defaultPackName')
      ?? this.settings?.get?.('customEmoji.defaultPackName')
      ?? '';
    const template = String(
      this.settings?.getForUser?.(userId, 'customEmoji.packNameTemplate')
      ?? this.settings?.get?.('customEmoji.packNameTemplate')
      ?? '{name}'
    ).trim();
    const botName = this.settings?.get?.('general.botName') || 'Lancy';
    const userRow = userId ? this.db?.get?.('SELECT first_name, username FROM users WHERE tg_id = ?', userId) : null;
    const ownerLabel = userRow?.first_name || (userRow?.username ? `@${userRow.username}` : 'Creator');

    let baseName = explicit || String(userOrGlobal || '').trim();
    if (!baseName) {
      const cleanQ = extractCleanStickerName(fallbackQuery || 'Custom Emojis');
      baseName = fallbackQuery ? `${cleanQ} Emojis` : 'Lancy Custom Emojis';
    }

    if (!explicit && template && template !== '{name}') {
      const rendered = template
        .replace(/\{name\}|\{\{name\}\}/gi, baseName)
        .replace(/\{bot\}/gi, botName)
        .replace(/\{user\}/gi, ownerLabel)
        .trim();
      if (rendered) baseName = rendered;
    }

    return cleanTgTitle(baseName);
  }

  /** Check whether user currently has a personal pack-name override or inherits global default. */
  getPackNameConfig(userId) {
    const globalDefault = String(this.settings?.get?.('customEmoji.defaultPackName') || '').trim();
    const userOverride = this.db?.getUserSetting?.(Number(userId), 'customEmoji.defaultPackName', undefined);
    const effective = this.resolveEffectivePackName(userId);
    return {
      globalDefault,
      userOverride: userOverride !== undefined ? String(userOverride) : null,
      effective,
      autoEnhance: this.settings?.getForUser?.(userId, 'customEmoji.autoEnhance') ?? true,
      smartBorderTrim: this.settings?.getForUser?.(userId, 'customEmoji.smartBorderTrim') ?? true,
      hdExportFormat: this.settings?.getForUser?.(userId, 'customEmoji.hdExportFormat') ?? 'png_doc',
      hdExportSize: Number(this.settings?.getForUser?.(userId, 'customEmoji.hdExportSize') ?? 1024)
    };
  }

  /** Resolve per-sticker add delay (honoring explicit test overrides like 0ms, otherwise customEmoji fast pacing). */
  #resolveAddDelayMs() {
    const tgDelay = this.settings?.get?.('telegram.stickerAddDelayMs');
    if (tgDelay !== undefined && tgDelay !== null && Number(tgDelay) < 100) {
      return Math.max(0, Number(tgDelay) || 0);
    }
    const ceDelay = this.settings?.get?.('customEmoji.addDelayMs');
    return ceDelay !== undefined && ceDelay !== null ? Math.max(0, Number(ceDelay) || 0) : 40;
  }

  /** Create Telegram set with initial batch (up to batchSize), falling back cleanly to 1+add loop if rejected. */
  async #createAndPopulateSet({ userId, shortName, title, partItems, stickerType = 'custom_emoji', initialBatch = 1, thumbnail = false, partNum = 1, totalParts = 1, onProgress } = {}) {
    const initialCount = Math.min(partItems.length, Math.max(1, initialBatch));
    let initial = partItems.slice(0, initialCount);
    let rest = partItems.slice(initialCount);

    try {
      await withRetry(() => this.api.createNewStickerSet({
        userId,
        name: shortName,
        title,
        stickers: initial.map((it) => this.#toInputSticker(it)),
        stickerType
      }), { attempts: 2 });
    } catch (batchErr) {
      if (initialCount <= 1) throw batchErr;
      this.log?.warn?.({ err: batchErr?.message, initialCount }, 'batch createNewStickerSet rejected, falling back to 1-by-1 creation');
      initial = partItems.slice(0, 1);
      rest = partItems.slice(1);
      await withRetry(() => this.api.createNewStickerSet({
        userId,
        name: shortName,
        title,
        stickers: initial.map((it) => this.#toInputSticker(it)),
        stickerType
      }), { attempts: 2 });
    }

    if (thumbnail && partItems[0]?.format === 'static' && partItems[0]?.buffer) {
      try {
        const thumb = await toThumbnail(partItems[0].buffer);
        await this.api.setStickerSetThumbnail({ name: shortName, userId, thumbnail: { buffer: thumb.buffer, filename: 'thumb.webp' } }).catch(() => {});
      } catch {}
    }

    let done = initial.length;
    onProgress?.({ stage: rest.length ? 'adding' : 'creating', done, total: partItems.length, part: partNum, totalParts });
    const delay = this.#resolveAddDelayMs();
    for (const item of rest) {
      try {
        await withRetry(() => this.api.addStickerToSet({
          userId,
          name: shortName,
          sticker: this.#toInputSticker(item)
        }), { attempts: 2 });
        done++;
      } catch (err) {
        this.log?.warn?.({ err: err?.message, done }, 'addStickerToSet failed on custom emoji, trying fallback emoji');
        try {
          const fb = { ...this.#toInputSticker(item), emoji_list: ['✨'] };
          await this.api.addStickerToSet({ userId, name: shortName, sticker: fb });
          done++;
        } catch {}
      }
      onProgress?.({ stage: 'adding', done, total: partItems.length, part: partNum, totalParts });
      if (delay > 0) await sleep(delay);
    }
    return done;
  }

  /** Convert an array of raw media/sticker descriptors into ready 100x100 custom emoji assets. */
  async prepareCustomEmojiItems(descriptors, { userId, query = '', onProgress } = {}) {
    const autoEnhance = this.settings?.getForUser?.(userId, 'customEmoji.autoEnhance') ?? true;
    const smartBorderTrim = this.settings?.getForUser?.(userId, 'customEmoji.smartBorderTrim') ?? true;
    const defaultEmoji = String(this.settings?.getForUser?.(userId, 'customEmoji.defaultEmoji') || '✨');
    const configuredFfmpeg = this.settings?.get?.('media.ffmpegPath') ?? '';

    const total = descriptors.length;
    let completed = 0;
    const concurrency = Math.min(8, Math.max(4, Math.floor((cpus()?.length || 4) / 2)));

    const settled = await runBounded(descriptors, concurrency, async (desc, index) => {
      try {
        const item = await toCustomEmojiAsset(desc, {
          autoEnhance,
          smartBorderTrim,
          defaultEmoji,
          configuredFfmpeg
        });
        const assignedEmoji = desc.emoji?.length
          ? desc.emoji
          : emojisForSticker({ query, packEmoji: defaultEmoji, index, assignment: 'auto' });
        return {
          ...item,
          _emojiAsset: true,
          emoji: assignedEmoji.map((e) => (e === '♡' ? '🤍' : e)).filter(Boolean)
        };
      } finally {
        completed++;
        onProgress?.({ stage: 'converting', done: completed, total });
      }
    });

    const items = [];
    for (const res of settled) {
      if (res?.status === 'fulfilled' && res.value) {
        items.push(res.value);
      } else if (res?.status === 'rejected') {
        this.log?.warn?.({ err: res.reason?.message }, 'skipped unconvertible custom emoji source');
      }
    }
    return items;
  }

  #toInputSticker(item) {
    const format = item.format === 'video' ? 'video' : (item.format === 'animated' ? 'animated' : 'static');
    const ext = format === 'video' ? 'webm' : (format === 'animated' ? 'tgs' : 'webp');
    const emojis = (Array.isArray(item.emoji) ? item.emoji : [item.emoji || '✨'])
      .map((e) => (e === '♡' ? '🤍' : e))
      .filter(Boolean);
    return {
      sticker: { buffer: item.buffer, filename: item.filename || `emoji.${ext}` },
      format,
      emoji_list: emojis.length ? emojis : ['✨']
    };
  }

  /** Create one (or auto-split Part 02) custom_emoji set(s) on Telegram + persist to DB. */
  async createCustomEmojiPack({ userId, title, shortName, descriptors, query = '', source = 'manual', onProgress }) {
    if (!descriptors?.length) {
      throw new LancyError('♡ No valid media items found to build an emoji pack.', { code: 'NO_MEDIA' });
    }
    const rawItems = descriptors.every((d) => d?._emojiAsset && Buffer.isBuffer(d.buffer))
      ? descriptors
      : await this.prepareCustomEmojiItems(descriptors, { userId, query, onProgress });

    const seenCreateHashes = new Set();
    const items = rawItems.filter((it) => {
      const k = it.sha256 || it.sourceSha256;
      if (!k) return true;
      if (seenCreateHashes.has(k)) return false;
      seenCreateHashes.add(k);
      return true;
    });

    if (!items.length) {
      throw new LancyError('♡ Could not convert any uploaded items to Telegram Custom Emoji format.', { code: 'CONVERT_FAILED' });
    }

    const limits = resolveLimits(this.settings, 'custom_emoji');
    const perSet = limits.perSet || 200;
    const baseTitle = this.resolveEffectivePackName(userId, title, { fallbackQuery: query });
    const botUsername = this.#botUsername();
    const taken = new Set(this.db.all('SELECT tg_short_name AS name FROM sticker_packs WHERE user_id = ?', userId).map((r) => r.name));

    const chunks = [];
    for (let i = 0; i < items.length; i += perSet) {
      chunks.push(items.slice(i, i + perSet));
    }

    const createdPacks = [];
    for (let partIdx = 0; partIdx < chunks.length; partIdx++) {
      const partNum = partIdx + 1;
      const partItems = chunks[partIdx];
      const partTitle = validateTitle(cleanTgTitle(partNum > 1 ? `${baseTitle} ${String(partNum).padStart(2, '0')}` : baseTitle));
      const partShortName = shortName
        ? (partNum > 1 ? `${shortName}_${partNum}` : shortName)
        : buildShortName({ query: `ce_${partTitle}`, botUsername, userId, taken });
      taken.add(partShortName);

      onProgress?.({ stage: 'creating', done: 0, total: partItems.length, part: partNum, totalParts: chunks.length });
      const batchLimit = Math.max(
        limits.createInitialLimit || 1,
        Math.min(50, Number(this.settings?.get?.('customEmoji.createBatchSize')) || 25)
      );
      const done = await this.#createAndPopulateSet({
        userId,
        shortName: partShortName,
        title: partTitle,
        partItems,
        stickerType: 'custom_emoji',
        initialBatch: batchLimit,
        thumbnail: false,
        partNum,
        totalParts: chunks.length,
        onProgress
      });

      const formats = new Set(partItems.map((it) => it.format));
      const summaryType = formats.size > 1 ? 'mixed' : (formats.values().next().value || 'static');
      const link = `https://t.me/addemoji/${partShortName}`;

      // Persist & sync file_ids + custom_emoji_ids
      const row = this.db.run(
        `INSERT INTO sticker_packs
           (user_id, tg_short_name, tg_title, query, count, source, sticker_type, sticker_kind, link, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'custom_emoji', ?, ?)`,
        userId, partShortName, partTitle, query || partTitle, done, source, summaryType, link,
        JSON.stringify({ createdVia: 'custom-emoji-studio' })
      );
      const packId = Number(row.lastInsertRowid);
      const stmt = this.db.prepare(
        'INSERT INTO sticker_items (pack_id, position, emoji, sha256, phash, type, item_format, source_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      partItems.forEach((it, idx) => {
        stmt.run(
          packId,
          idx,
          Array.isArray(it.emoji) ? it.emoji.join(' ') : (it.emoji ?? '✨'),
          it.sha256 ?? null,
          it.phash ?? null,
          it.format,
          it.format,
          it.sourceSha256 ?? null
        );
        if (it.sha256) this.media?.cache?.pin?.(it.sha256);
        if (it.sourceSha256 && it.sourceBuffer) {
          this.media?.cache?.put?.(it.sourceSha256, it.sourceBuffer, { ext: 'bin' });
          this.media?.cache?.pin?.(it.sourceSha256);
        }
      });

      await this.packService?.syncPackStickersFromTelegram?.({ id: packId, shortName: partShortName, stickerKind: 'custom_emoji' });
      const livePack = this.packService?.getPack?.(userId, packId);
      createdPacks.push({
        packId,
        name: partShortName,
        title: partTitle,
        count: livePack?.count ?? done,
        link,
        stickerKind: 'custom_emoji',
        stickerType: summaryType
      });
    }

    onProgress?.({ stage: 'done', done: items.length, total: items.length });
    return {
      ...createdPacks[0],
      extraPacks: createdPacks.slice(1),
      allPacks: createdPacks
    };
  }

  /** Append custom emojis to an existing pack (dedup + <=200 overflow auto-split). */
  async addItemsToPack({ userId, packId, descriptors, onProgress }) {
    const pack = this.packService?.getPack?.(userId, packId);
    if (!pack) throw new LancyError('♡ Could not find that emoji pack.', { code: 'PACK_NOT_FOUND' });

    const prepped = descriptors.every((d) => d?._emojiAsset && Buffer.isBuffer(d.buffer))
      ? descriptors
      : await this.prepareCustomEmojiItems(descriptors, { userId, query: pack.query || pack.title, onProgress });

    const existingSha = new Set(
      this.db.all('SELECT sha256 FROM sticker_items WHERE pack_id = ? AND sha256 IS NOT NULL', packId).map((r) => r.sha256)
    );
    const existingSrcSha = new Set(
      this.db.all('SELECT source_sha256 FROM sticker_items WHERE pack_id = ? AND source_sha256 IS NOT NULL', packId).map((r) => r.source_sha256)
    );
    const existingPhash = new Set(
      this.db.all('SELECT phash FROM sticker_items WHERE pack_id = ? AND phash IS NOT NULL', packId).map((r) => r.phash)
    );

    const uniqueItems = prepped.filter((it) => {
      if (it.sha256 && existingSha.has(it.sha256)) return false;
      if (it.sourceSha256 && existingSrcSha.has(it.sourceSha256)) return false;
      if (it.phash && existingPhash.has(it.phash)) return false;
      if (it.sha256) existingSha.add(it.sha256);
      if (it.sourceSha256) existingSrcSha.add(it.sourceSha256);
      if (it.phash) existingPhash.add(it.phash);
      return true;
    });

    if (!uniqueItems.length) {
      return { packId, name: pack.shortName, title: pack.title, count: pack.count, added: 0, skippedDupes: prepped.length, link: pack.link };
    }

    const limits = resolveLimits(this.settings, 'custom_emoji');
    const perSet = limits.perSet || 200;
    let liveCount = pack.count;
    try {
      const liveSet = await this.api.getStickerSet(pack.shortName);
      if (typeof liveSet?.stickers?.length === 'number') liveCount = liveSet.stickers.length;
    } catch {}

    const capacity = Math.max(0, perSet - liveCount);
    const fitItems = uniqueItems.slice(0, capacity);
    const overflowItems = uniqueItems.slice(capacity);
    let added = 0;

    if (fitItems.length > 0) {
      const delay = this.#resolveAddDelayMs();
      for (const item of fitItems) {
        try {
          await withRetry(() => this.api.addStickerToSet({
            userId,
            name: pack.shortName,
            sticker: this.#toInputSticker(item)
          }), { attempts: 2 });
          added++;
          this.db.run(
            'INSERT INTO sticker_items (pack_id, position, emoji, sha256, phash, type, item_format, source_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            packId,
            liveCount + added - 1,
            Array.isArray(item.emoji) ? item.emoji.join(' ') : (item.emoji ?? '✨'),
            item.sha256 ?? null,
            item.phash ?? null,
            item.format,
            item.format,
            item.sourceSha256 ?? null
          );
          if (item.sourceSha256 && item.sourceBuffer) {
            this.media?.cache?.put?.(item.sourceSha256, item.sourceBuffer, { ext: 'bin' });
            this.media?.cache?.pin?.(item.sourceSha256);
          }
        } catch (err) {
          this.log?.warn?.({ err: err?.message }, 'addItemsToPack item skipped');
        }
        onProgress?.({ stage: 'adding', done: added, total: fitItems.length });
        if (delay > 0) await sleep(delay);
      }
      await this.packService?.syncPackStickersFromTelegram?.(pack);
    }

    let splitPack = null;
    if (overflowItems.length > 0) {
      splitPack = await this.createCustomEmojiPack({
        userId,
        title: `${pack.title} 02`,
        descriptors: overflowItems,
        query: pack.query || pack.title,
        source: 'merge-overflow',
        onProgress
      });
    }

    const updated = this.packService?.getPack?.(userId, packId);
    return {
      packId,
      name: pack.shortName,
      title: updated?.title ?? pack.title,
      count: updated?.count ?? (liveCount + added),
      added,
      skippedDupes: prepped.length - uniqueItems.length,
      link: pack.link || `https://t.me/addemoji/${pack.shortName}`,
      splitPack
    };
  }

  /**
   * Merge sourcePackId INTO targetPackId (cross-kind supported: regular sticker pack
   * items are automatically enhanced & resized to 100x100 custom emojis).
   */
  async mergePacks({ userId, targetPackId, sourcePackId, deleteSource = false, onProgress }) {
    if (Number(targetPackId) === Number(sourcePackId)) {
      throw new LancyError('♡ Pick two different packs to merge.', { code: 'SAME_PACK' });
    }
    const target = this.packService?.getPack?.(userId, targetPackId);
    const source = this.packService?.getPack?.(userId, sourcePackId);
    if (!target || !source) {
      throw new LancyError('♡ One of the selected packs could not be found.', { code: 'PACK_NOT_FOUND' });
    }

    const descriptors = await this.#downloadPackItems(source, { onProgress });
    if (!descriptors.length) {
      throw new LancyError('♡ The source pack had no downloadable items.', { code: 'EMPTY_SOURCE' });
    }

    const res = await this.addItemsToPack({
      userId,
      packId: targetPackId,
      descriptors,
      onProgress
    });

    if (deleteSource && (res.added > 0 || res.skippedDupes > 0 || res.splitPack)) {
      await this.packService?.deletePack?.(userId, sourcePackId).catch(() => {});
    }

    return {
      ...res,
      sourceTitle: source.title,
      sourceDeleted: Boolean(deleteSource)
    };
  }

  /**
   * Clone & rename ANY public Telegram sticker or custom emoji pack into either a
   * Custom Emoji Pack (100x100, preserving .tgs/.webm/.webp) OR Regular Sticker Pack (512x512).
   */
  async cloneAndRenamePack({ userId, shortName, targetTitle = null, targetKind = 'custom_emoji', onProgress }) {
    const cleanShort = extractTelegramPackName(shortName) || String(shortName || '').trim();
    const srcSet = await this.api.getStickerSet(cleanShort);
    if (!srcSet?.stickers?.length) {
      throw new LancyError('♡ That Telegram pack has no stickers.', { code: 'EMPTY_SET' });
    }
    if (srcSet.sticker_type === 'custom_emoji') {
      this.customEmojiRegistry?.registerPackSet?.(srcSet, { userId, source: 'discovered' });
    }

    const total = srcSet.stickers.length;
    onProgress?.({ stage: 'downloading', done: 0, total });
    const descriptors = await this.#downloadLiveStickers(srcSet.stickers, { onProgress });

    if (!descriptors.length) {
      throw new LancyError('♡ Failed to download items from that pack.', { code: 'DOWNLOAD_FAILED' });
    }

    const resolvedTitle = targetTitle
      ? cleanTgTitle(targetTitle)
      : this.resolveEffectivePackName(userId, null, { fallbackQuery: srcSet.title || shortName });

    if (targetKind === 'regular') {
      const configuredFfmpeg = this.settings?.get?.('media.ffmpegPath') ?? '';
      let regDone = 0;
      const settledReg = await runBounded(descriptors, 6, async (d) => {
        try {
          let item;
          if (srcSet.sticker_type === 'custom_emoji') {
            item = await toRegularStickerFromEmoji(d.buffer, { configuredFfmpeg });
          } else if (d.isAnimated) {
            item = { buffer: d.buffer, format: 'animated', filename: 'sticker.tgs' };
          } else if (d.isVideo) {
            const v = await toTelegramVideoSticker(d.buffer, { configuredFfmpeg });
            item = { ...v, format: 'video', filename: 'sticker.webm' };
          } else {
            const s = await toTelegramStaticSticker(d.buffer, { configuredFfmpeg });
            item = { ...s, format: 'static', filename: 'sticker.webp' };
          }
          return { ...item, emoji: d.emoji };
        } finally {
          regDone++;
          onProgress?.({ stage: 'converting', done: regDone, total: descriptors.length });
        }
      });
      const regItems = settledReg.filter((r) => r?.status === 'fulfilled' && r.value).map((r) => r.value);
      if (!regItems.length) {
        throw new LancyError('♡ Could not convert items to regular sticker pack.', { code: 'CONVERT_FAILED' });
      }
      return this.#createRegularMixedPack({
        userId,
        title: resolvedTitle,
        query: srcSet.title || shortName,
        items: regItems,
        onProgress
      });
    }

    return this.createCustomEmojiPack({
      userId,
      title: resolvedTitle,
      descriptors,
      query: srcSet.title || shortName,
      source: 'clone',
      onProgress
    });
  }

  /** Live-rename a bot-owned custom emoji (or sticker) pack title on Telegram + DB. */
  async renamePackTitle({ userId, packId, newTitle }) {
    const pack = this.packService?.getPack?.(userId, packId);
    if (!pack) throw new LancyError('♡ Pack not found.', { code: 'PACK_NOT_FOUND' });
    const title = validateTitle(cleanTgTitle(newTitle));
    await this.api.setStickerSetTitle({ name: pack.shortName, title });
    this.db.run(
      "UPDATE sticker_packs SET tg_title = ?, modified_at = datetime('now') WHERE id = ? AND user_id = ?",
      title, packId, userId
    );
    return { ...pack, title };
  }

  /** Remove a specific sticker/emoji item by file_id from Telegram + DB. */
  async deletePackItem({ userId, packId, fileId }) {
    const pack = this.packService?.getPack?.(userId, packId);
    if (!pack) throw new LancyError('♡ Pack not found.', { code: 'PACK_NOT_FOUND' });
    await this.api.deleteStickerFromSet(fileId);
    this.db.run('DELETE FROM sticker_items WHERE pack_id = ? AND file_id = ?', packId, fileId);
    await this.packService?.syncPackStickersFromTelegram?.(pack);
    return this.packService?.getPack?.(userId, packId);
  }

  /** Download Telegram Sticker objects concurrently using a rolling pool of 12 workers. */
  async #downloadLiveStickers(liveList, { onProgress } = {}) {
    let dlDone = 0;
    const total = liveList.length;
    const settled = await runBounded(liveList, 12, async (st) => {
      try {
        const info = await this.api.getFile(st.file_id);
        const buf = await this.api.downloadFile(info.file_path);
        return {
          buffer: buf,
          emoji: st.emoji ? [st.emoji] : ['✨'],
          isVideo: Boolean(st.is_video),
          isAnimated: Boolean(st.is_animated),
          format: st.is_animated ? 'animated' : (st.is_video ? 'video' : 'static')
        };
      } finally {
        dlDone++;
        onProgress?.({ stage: 'downloading', done: dlDone, total });
      }
    });
    const descriptors = [];
    for (const r of settled) {
      if (r?.status === 'fulfilled' && r.value?.buffer) descriptors.push(r.value);
    }
    return descriptors;
  }

  /** Fetch downloadable buffers + metadata for every item in a DB pack. */
  async #downloadPackItems(pack, { onProgress } = {}) {
    const set = await this.api.getStickerSet(pack.shortName).catch(() => null);
    const liveList = set?.stickers ?? [];
    if (!liveList.length) {
      const dbRows = this.db.all('SELECT * FROM sticker_items WHERE pack_id = ? ORDER BY position ASC', pack.id);
      const out = [];
      for (const r of dbRows) {
        const cached = r.source_sha256 ? this.media?.cache?.read?.(r.source_sha256) : (r.sha256 ? this.media?.cache?.read?.(r.sha256) : null);
        if (cached) {
          out.push({
            buffer: cached,
            emoji: r.emoji ? r.emoji.split(/\s+/).filter(Boolean) : ['✨'],
            isVideo: r.item_format === 'video' || r.type === 'video',
            isAnimated: r.item_format === 'animated' || r.type === 'animated'
          });
        }
      }
      return out;
    }
    return this.#downloadLiveStickers(liveList, { onProgress });
  }

  /** Publish a mixed-format (static/video/animated) 512px Regular Sticker Pack cleanly. */
  async #createRegularMixedPack({ userId, title, query, items, onProgress }) {
    const hasVideoOnly = items.every((i) => i.format === 'video');
    const limits = resolveLimits(this.settings, hasVideoOnly ? 'video' : 'static');
    const perSet = hasVideoOnly ? 50 : 120;
    const botUsername = this.#botUsername();
    const taken = new Set(this.db.all('SELECT tg_short_name AS name FROM sticker_packs WHERE user_id = ?', userId).map((r) => r.name));
    const chunks = [];
    for (let i = 0; i < items.length; i += perSet) chunks.push(items.slice(i, i + perSet));

    const createdPacks = [];
    for (let partIdx = 0; partIdx < chunks.length; partIdx++) {
      const partNum = partIdx + 1;
      const partItems = chunks[partIdx];
      const partTitle = validateTitle(cleanTgTitle(partNum > 1 ? `${title} ${String(partNum).padStart(2, '0')}` : title));
      const shortName = buildShortName({ query: partTitle, botUsername, userId, taken });
      taken.add(shortName);

      const done = await this.#createAndPopulateSet({
        userId,
        shortName,
        title: partTitle,
        partItems,
        stickerType: 'regular',
        initialBatch: limits.createInitialLimit || 1,
        thumbnail: true,
        partNum,
        totalParts: chunks.length,
        onProgress
      });

      const formats = new Set(partItems.map((it) => it.format));
      const summaryType = formats.has('video') && !formats.has('static') ? 'video' : 'static';
      const link = `https://t.me/addstickers/${shortName}`;
      const row = this.db.run(
        `INSERT INTO sticker_packs
           (user_id, tg_short_name, tg_title, query, count, source, sticker_type, sticker_kind, link, meta_json)
         VALUES (?, ?, ?, ?, ?, 'clone', ?, 'regular', ?, ?)`,
        userId, shortName, partTitle, query || partTitle, done, summaryType, link,
        JSON.stringify({ convertedFrom: 'custom_emoji' })
      );
      const packId = Number(row.lastInsertRowid);
      await this.packService?.syncPackStickersFromTelegram?.({ id: packId, shortName, stickerKind: 'regular' });
      createdPacks.push({ packId, name: shortName, title: partTitle, count: done, link, stickerKind: 'regular', stickerType: summaryType });
    }
    return { ...createdPacks[0], extraPacks: createdPacks.slice(1), allPacks: createdPacks };
  }
}
