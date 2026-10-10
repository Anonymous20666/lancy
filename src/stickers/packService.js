import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { resolveLimits, buildShortName, cleanTgTitle } from './limits.js';
import { prepareStickerItems } from './telegram.js';
import { titleCase } from '../utils/text.js';

/**
 * StickerPackService — the orchestration layer between Pinterest results and
 * a finished Telegram sticker pack:
 *
 *   media descriptors → convert (quality-preserving) → createNewStickerSet
 *     → addStickerToSet (one by one) → thumbnail → DB record
 *
 * Every pack is recorded in the DB with its metadata so "My Packs" and
 * "Add to Existing" work across restarts.
 */
export class StickerPackService extends EventEmitter {
  constructor({ db, settings, stickerService, media, log } = {}) {
    super();
    this.db = db;
    this.settings = settings;
    this.stickerService = stickerService;
    this.media = media;
    this.log = log ?? logger().child({ module: 'pack-service' });
  }

  /**
   * Create a Telegram pack from validated media descriptors.
   * @param {object} opts
   * @param {number} opts.userId telegram user id (pack owner)
   * @param {string} opts.query original search
   * @param {string} [opts.title] pack title (defaults from settings)
   * @param {string} [opts.shortName] override short name
   * @param {Array} opts.descriptors validated media descriptors (with buffer)
   * @param {string} [opts.stickerType] 'static' | 'video'
   * @param {(info) => void} [opts.onProgress]
   */
  async createPackFromMedia({ userId, query, title, shortName, descriptors, stickerType = 'static', onProgress }) {
    if (!descriptors?.length) {
      throw new LancyError('♡ There is no usable media for a pack yet.', { code: 'NO_MEDIA' });
    }
    const limits = resolveLimits(this.settings, stickerType === 'video' ? 'video' : 'static');
    const perSet = limits.perSet;

    // Convert media → sticker bytes (bounded, sequential per pack)
    const allItems = await prepareStickerItems(descriptors, {
      stickerService: this.stickerService,
      query,
      stickerType,
      onProgress: (info) => onProgress?.({ ...info, stage: 'converting' })
    });

    const botUsername = this.stickerService.api.botUsername || 'lancybot';
    const taken = new Set(this.db.all('SELECT tg_short_name AS name FROM sticker_packs WHERE user_id = ?', userId).map((r) => r.name));

    // Chunk into physical Telegram sets (max perSet each, e.g. 120)
    const chunks = [];
    for (let i = 0; i < allItems.length; i += perSet) {
      chunks.push(allItems.slice(i, i + perSet));
    }

    const createdPacks = [];
    for (let partIdx = 0; partIdx < chunks.length; partIdx++) {
      const partNum = partIdx + 1;
      const partItems = chunks[partIdx];
      const partTitle = title
        ? (partNum > 1 ? `${title} ${String(partNum).padStart(2, '0')}` : title)
        : this.#defaultTitle(userId, query, partNum);
      const partName = shortName
        ? (partNum > 1 ? `${shortName}_${partNum}` : shortName)
        : buildShortName({ query: partTitle, botUsername, userId, taken });
      taken.add(partName);

      const created = await this.stickerService.createPack({
        userId,
        title: cleanTgTitle(partTitle),
        shortName: partName,
        items: partItems,
        query,
        stickerType,
        thumbnail: this.settings?.get('stickers.thumbnail') ?? true,
        onProgress: (info) => onProgress?.({ ...info, stage: info.stage === 'done' ? 'done' : 'adding', part: partNum, totalParts: chunks.length })
      });

      // Persist the pack + items.
      const packId = this.#persistPack({
        userId, query, title: partTitle, shortName: created.name,
        count: created.count, link: created.link, stickerType, items: partItems
      });

      // Sync real Telegram file_ids into sticker_items
      await this.syncPackStickersFromTelegram({ id: packId, shortName: created.name }).catch(() => {});

      // Pin media in cache so cleanup won't touch it
      partItems.forEach((item) => {
        if (item.sha256) this.media?.cache?.pin(item.sha256);
      });

      createdPacks.push({ packId, ...created, items: partItems });
    }

    onProgress?.({ stage: 'done', done: allItems.length, total: allItems.length });
    const primary = createdPacks[0];
    return {
      ...primary,
      extraPacks: createdPacks.slice(1),
      allPacks: createdPacks
    };
  }

  /** Add more stickers to an existing pack with capacity auto-split. */
  async addToPack({ userId, packId, descriptors, stickerType = 'static', onProgress }) {
    const pack = this.db.get('SELECT * FROM sticker_packs WHERE id = ? AND user_id = ?', packId, userId);
    if (!pack) throw new LancyError('♡ I could not find that pack.', { code: 'PACK_NOT_FOUND' });

    // Exclude any stickers already in this pack so duplicates are never added
    const existingSha = new Set(
      this.db.all('SELECT sha256 FROM sticker_items WHERE pack_id = ? AND sha256 IS NOT NULL', packId).map((r) => r.sha256)
    );
    const existingPhash = new Set(
      this.db.all('SELECT phash FROM sticker_items WHERE pack_id = ? AND phash IS NOT NULL', packId).map((r) => r.phash)
    );
    const newDescriptors = descriptors.filter((d) => {
      if (d.sha256 && existingSha.has(d.sha256)) return false;
      if (d.phash && existingPhash.has(d.phash)) return false;
      return true;
    });

    if (!newDescriptors.length) {
      return { packId, count: pack.count, added: 0, items: [] };
    }

    const limits = resolveLimits(this.settings, pack.sticker_type ?? stickerType);
    const capacity = Math.max(0, limits.perSet - pack.count);

    if (capacity <= 0) {
      // Pack is full — auto-create part 2 directly!
      const part2Title = `${pack.tg_title} 02`;
      return this.createPackFromMedia({
        userId,
        query: pack.query ?? 'stickers',
        title: part2Title,
        descriptors: newDescriptors,
        stickerType: pack.sticker_type ?? stickerType,
        onProgress
      });
    }

    const fitDescriptors = newDescriptors.slice(0, capacity);
    const overflowDescriptors = newDescriptors.slice(capacity);

    const items = await prepareStickerItems(fitDescriptors, {
      stickerService: this.stickerService,
      query: pack.query ?? '',
      stickerType: pack.sticker_type ?? stickerType,
      onProgress
    });
    const result = await this.stickerService.addToPack({
      userId,
      shortName: pack.tg_short_name,
      items,
      stickerType: pack.sticker_type ?? stickerType,
      onProgress
    });
    this.db.run(
      'UPDATE sticker_packs SET count = ?, modified_at = datetime(\'now\') WHERE id = ?',
      result.count, packId
    );
    items.forEach((item, i) => {
      this.db.run(
        'INSERT INTO sticker_items (pack_id, position, emoji, sha256, phash, type) VALUES (?, ?, ?, ?, ?, ?)',
        packId, (pack.count ?? 0) + i, item.emoji?.join(' ') ?? null, item.sha256 ?? null, item.phash ?? null, item.type ?? 'static'
      );
    });

    let splitPack = null;
    if (overflowDescriptors.length > 0) {
      const part2Title = `${pack.tg_title} 02`;
      splitPack = await this.createPackFromMedia({
        userId,
        query: pack.query ?? 'stickers',
        title: part2Title,
        descriptors: overflowDescriptors,
        stickerType: pack.sticker_type ?? stickerType,
        onProgress
      });
    }

    return {
      packId,
      ...result,
      splitPack,
      allPacks: splitPack ? [this.getPack(userId, packId), ...(splitPack.allPacks ?? [splitPack])] : [this.getPack(userId, packId)]
    };
  }

  listAvailablePacks(userId, { limit = 10, offset = 0, stickerType = null } = {}) {
    if (stickerType && stickerType !== 'all') {
      const limits = resolveLimits(this.settings, stickerType);
      const type = stickerType === 'video' ? 'video' : 'static';
      const rows = this.db.all(
        `SELECT * FROM sticker_packs
         WHERE user_id = ?
           AND (sticker_type = ? OR (sticker_type IS NULL AND ? = 'static'))
           AND count < ?
         ORDER BY modified_at DESC LIMIT ? OFFSET ?`,
        userId, type, type, limits.perSet, limit, offset
      );
      const total = this.db.get(
        `SELECT COUNT(*) AS c FROM sticker_packs
         WHERE user_id = ?
           AND (sticker_type = ? OR (sticker_type IS NULL AND ? = 'static'))
           AND count < ?`,
        userId, type, type, limits.perSet
      )?.c ?? 0;
      return { packs: rows.map((r) => this.#decorate(r)), total };
    }

    const staticLimit = resolveLimits(this.settings, 'static').perSet;
    const videoLimit = resolveLimits(this.settings, 'video').perSet;
    const rows = this.db.all(
      `SELECT * FROM sticker_packs
       WHERE user_id = ?
         AND (
           ((sticker_type = 'video') AND count < ?)
           OR
           ((sticker_type != 'video' OR sticker_type IS NULL) AND count < ?)
         )
       ORDER BY modified_at DESC LIMIT ? OFFSET ?`,
      userId, videoLimit, staticLimit, limit, offset
    );
    const total = this.db.get(
      `SELECT COUNT(*) AS c FROM sticker_packs
       WHERE user_id = ?
         AND (
           ((sticker_type = 'video') AND count < ?)
           OR
           ((sticker_type != 'video' OR sticker_type IS NULL) AND count < ?)
         )`,
      userId, videoLimit, staticLimit
    )?.c ?? 0;
    return { packs: rows.map((r) => this.#decorate(r)), total };
  }

  /** The user's packs, newest first, with pagination. */
  listPacks(userId, { limit = 5, offset = 0, query = '' } = {}) {
    const trimmed = (query ?? '').trim();
    if (trimmed) {
      const rows = this.db.all(
        `SELECT * FROM sticker_packs WHERE user_id = ? AND (tg_title LIKE ? OR query LIKE ?) ORDER BY modified_at DESC LIMIT ? OFFSET ?`,
        userId, `%${trimmed}%`, `%${trimmed}%`, limit, offset
      );
      const total = this.db.get(
        'SELECT COUNT(*) AS c FROM sticker_packs WHERE user_id = ? AND (tg_title LIKE ? OR query LIKE ?)',
        userId, `%${trimmed}%`, `%${trimmed}%`
      )?.c ?? 0;
      return { packs: rows.map((r) => this.#decorate(r)), total };
    }
    const rows = this.db.all(
      `SELECT * FROM sticker_packs WHERE user_id = ? ORDER BY modified_at DESC LIMIT ? OFFSET ?`,
      userId, limit, offset
    );
    const total = this.db.get('SELECT COUNT(*) AS c FROM sticker_packs WHERE user_id = ?', userId)?.c ?? 0;
    return { packs: rows.map((r) => this.#decorate(r)), total };
  }

  getPack(userId, packId) {
    const row = this.db.get('SELECT * FROM sticker_packs WHERE id = ? AND user_id = ?', packId, userId);
    return row ? this.#decorate(row) : null;
  }

  /** Sync all sticker file_ids from Telegram into sticker_items in a single batch. */
  async syncPackStickersFromTelegram(pack) {
    const sName = pack?.shortName ?? pack?.tg_short_name ?? pack?.name;
    if (!sName || !this.stickerService?.api) return;
    try {
      const set = await this.stickerService.api.getStickerSet(sName);
      if (set?.stickers?.length) {
        const rows = this.db.all('SELECT id, position FROM sticker_items WHERE pack_id = ? ORDER BY position ASC', pack.id);
        const updateStmt = this.db.prepare('UPDATE sticker_items SET file_id = ?, type = ? WHERE id = ?');
        for (let i = 0; i < set.stickers.length; i++) {
          const st = set.stickers[i];
          const fileId = st.is_animated && (st.thumbnail || st.thumb) ? (st.thumbnail || st.thumb).file_id : st.file_id;
          const stType = (st.is_video || set.sticker_type === 'video') ? 'video' : 'static';
          if (rows[i]) {
            updateStmt.run(fileId, stType, rows[i].id);
          } else {
            this.db.run(
              'INSERT INTO sticker_items (pack_id, position, file_id, emoji, type) VALUES (?, ?, ?, ?, ?)',
              pack.id, i, fileId, st.emoji ?? '🤍', stType
            );
          }
        }
      }
    } catch (err) {
      this.log.debug({ err: err?.message, sName }, 'syncPackStickersFromTelegram skipped');
    }
  }

  /** Sticker bytes for publishing: prefer cached file, else download by file_id, auto-healing from Telegram if DB rows are missing. */
  async getStickerBytes(pack, index, { download } = {}) {
    let row = this.db.get(
      'SELECT id, file_id, sha256 FROM sticker_items WHERE pack_id = ? ORDER BY position ASC LIMIT 1 OFFSET ?',
      pack.id, index
    );
    if (row?.sha256) {
      const cached = this.media?.cache?.read?.(row.sha256);
      if (cached) return cached;
    }
    let fileId = row?.file_id;
    if (!fileId && (pack.shortName || pack.tg_short_name || pack.name)) {
      await this.syncPackStickersFromTelegram(pack).catch(() => {});
      row = this.db.get(
        'SELECT id, file_id, sha256 FROM sticker_items WHERE pack_id = ? ORDER BY position ASC LIMIT 1 OFFSET ?',
        pack.id, index
      );
      fileId = row?.file_id;
    }
    if (fileId && download) {
      const buffer = await download(fileId);
      if (buffer) {
        if (row?.sha256) this.media?.cache.store(buffer, { packId: pack.id, index });
        return buffer;
      }
    }
    return null;
  }

  async deletePack(userId, packId) {
    const pack = this.getPack(userId, packId);
    if (!pack) return false;
    if (pack.shortName) {
      try {
        await this.stickerService.api.deleteStickerSet(pack.shortName);
      } catch {}
    }
    this.db.run('DELETE FROM sticker_items WHERE pack_id = ?', packId);
    this.db.run('DELETE FROM sticker_packs WHERE id = ? AND user_id = ?', packId, userId);
    return true;
  }

  async clearAllPacks(userId) {
    const packs = this.db.all('SELECT id, tg_short_name FROM sticker_packs WHERE user_id = ?', userId);
    for (const p of packs) {
      if (p.tg_short_name) {
        try {
          await this.stickerService.api.deleteStickerSet(p.tg_short_name);
        } catch {}
      }
      this.db.run('DELETE FROM sticker_items WHERE pack_id = ?', p.id);
    }
    this.db.run('DELETE FROM sticker_packs WHERE user_id = ?', userId);
    return packs.length;
  }

  #defaultTitle(userId, query, part = 1) {
    const base = this.settings?.getForUser?.(userId, 'stickers.defaultPackName')
      ?? this.settings?.get('stickers.defaultPackName')
      ?? 'Lancy Pack';
    const q = titleCase(query ?? '');
    const title = q ? `${base} - ${q} stickers` : base;
    return part > 1 ? `${title} ${String(part).padStart(2, '0')}` : title;
  }

  #persistPack({ userId, query, title, shortName, count, link, stickerType, items }) {
    const row = this.db.run(
      `INSERT INTO sticker_packs
         (user_id, tg_short_name, tg_title, query, count, source, sticker_type, link, meta_json)
       VALUES (?, ?, ?, ?, ?, 'pinterest', ?, ?, ?)`,
      userId, shortName, title, query ?? null, count, stickerType, link,
      JSON.stringify({ createdVia: 'lancy-bot' })
    );
    const packId = Number(row.lastInsertRowid);
    const stmt = this.db.prepare(
      'INSERT INTO sticker_items (pack_id, position, emoji, sha256, phash, type) VALUES (?, ?, ?, ?, ?, ?)'
    );
    items.forEach((item, i) => {
      stmt.run(packId, i, item.emoji?.join(' ') ?? null, item.sha256 ?? null, item.phash ?? null, item.type ?? 'static');
    });
    return packId;
  }

  #decorate(row) {
    return {
      id: row.id,
      userId: row.user_id,
      shortName: row.tg_short_name,
      title: row.tg_title,
      query: row.query,
      count: row.count,
      source: row.source,
      stickerType: row.sticker_type,
      link: row.link,
      thumbFileId: row.thumb_file_id,
      createdAt: row.created_at,
      modifiedAt: row.modified_at,
      meta: this.db.readJsonColumn(row, 'meta_json')
    };
  }
}
