import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { resolveLimits, buildShortName } from './limits.js';
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
    if (descriptors.length > limits.perSet) {
      // Trim to the platform limit — never fail silently, never bypass it.
      this.log.warn({ requested: descriptors.length, limit: limits.perSet }, 'trimming to Telegram set limit');
      descriptors = descriptors.slice(0, limits.perSet);
    }

    const packTitle = title ?? this.#defaultTitle(query);
    const botUsername = this.stickerService.api.botUsername || 'lancybot';
    const taken = new Set(this.db.all('SELECT tg_short_name AS name FROM sticker_packs WHERE user_id = ?', userId).map((r) => r.name));
    const name = shortName ?? buildShortName({ query: packTitle, botUsername, userId, taken });

    // Convert media → sticker bytes (bounded, sequential per pack; the pack
    // creation itself is a single user-facing operation).
    const items = await prepareStickerItems(descriptors, {
      stickerService: this.stickerService,
      query,
      stickerType,
      onProgress: (info) => onProgress?.({ ...info, stage: 'converting' })
    });

    const created = await this.stickerService.createPack({
      userId,
      title: packTitle,
      shortName: name,
      items,
      query,
      stickerType,
      thumbnail: this.settings?.get('stickers.thumbnail') ?? true,
      onProgress: (info) => onProgress?.({ ...info, stage: info.stage === 'done' ? 'done' : 'adding' })
    });

    // Persist the pack + items.
    const packId = this.#persistPack({
      userId, query, title: packTitle, shortName: created.name,
      count: created.count, link: created.link, stickerType, items
    });

    onProgress?.({ stage: 'done', done: items.length, total: items.length });
    return { packId, ...created, items };
  }

  /** Add more stickers to an existing pack. */
  async addToPack({ userId, packId, descriptors, stickerType = 'static', onProgress }) {
    const pack = this.db.get('SELECT * FROM sticker_packs WHERE id = ? AND user_id = ?', packId, userId);
    if (!pack) throw new LancyError('♡ I could not find that pack.', { code: 'PACK_NOT_FOUND' });

    const items = await prepareStickerItems(descriptors, {
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
    for (const item of items) {
      this.db.run(
        'INSERT INTO sticker_items (pack_id, position, emoji, sha256, phash, type) VALUES (?, ?, ?, ?, ?, ?)',
        packId, result.count, item.emoji?.join(' '), item.sha256, item.phash, item.type
      );
    }
    return { packId, ...result };
  }

  /** The user's packs, newest first, with pagination. */
  listPacks(userId, { limit = 5, offset = 0 } = {}) {
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

  /** Sticker bytes for publishing: prefer cached file, else download by file_id. */
  async getStickerBytes(pack, index, { download } = {}) {
    const row = this.db.get(
      'SELECT file_id, sha256 FROM sticker_items WHERE pack_id = ? ORDER BY position ASC LIMIT 1 OFFSET ?',
      pack.id, index
    );
    if (!row) return null;
    if (row.sha256) {
      const cached = this.media?.cache.read(row.sha256);
      if (cached) return cached;
    }
    if (row.file_id && download) {
      const buffer = await download(row.file_id);
      if (row.sha256 && buffer) this.media?.cache.store(buffer, { packId: pack.id, index });
      return buffer;
    }
    return null;
  }

  #defaultTitle(query) {
    const base = this.settings?.get('stickers.defaultPackName') ?? 'Lancy Pack';
    const q = titleCase(query ?? '');
    return q ? `${q} • ${base}` : base;
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
