import { randomUUID } from 'node:crypto';
import { logger } from '../core/logger.js';

export class CinemaQueueManager {
  constructor({ app, db, api, playbackAdapter, log } = {}) {
    this.app = app;
    this.db = db || app?.db;
    this.api = api;
    this.playback = playbackAdapter;
    this.log = log || logger().child({ module: 'cinema:queue' });
    this.autoTvProgression = new Map(); // chatId -> boolean
    this.itemMeta = new Map(); // queue_item_id -> { poster, backdrop, year, rating, duration, episodeTitle, overview }

    // Safely ensure meta_json column exists without breaking existing schema
    try {
      this.db?.run?.("ALTER TABLE cinema_queue_items ADD COLUMN meta_json TEXT DEFAULT '{}'");
    } catch {}
  }

  #enrichRow(row) {
    if (!row) return null;
    let meta = {};
    try {
      if (row.meta_json) meta = JSON.parse(row.meta_json);
    } catch {}
    const cachedMeta = this.itemMeta.get(row.queue_item_id) || {};
    const merged = { ...meta, ...cachedMeta };
    return {
      ...row,
      poster: merged.poster || null,
      backdrop: merged.backdrop || null,
      year: merged.year || null,
      rating: merged.rating || null,
      duration: merged.duration || null,
      episodeTitle: merged.episodeTitle || null,
      overview: merged.overview || null,
      addedByName: merged.addedByName || null
    };
  }

  getQueue(chatId) {
    const numChat = Number(chatId);
    const rows = this.db.all(
      `SELECT q.* FROM cinema_queue_items q
       INNER JOIN cinema_destinations d ON q.destination_id = d.id
       WHERE d.chat_id = ? AND q.status = 'queued'
       ORDER BY q.position ASC`,
      numChat
    );
    return (rows || []).map(r => this.#enrichRow(r));
  }

  async addToQueue(chatId, {
    mediaType = 'movie',
    mediaId,
    title,
    season = null,
    episode = null,
    addedByUserId = 0,
    playNext = false,
    poster = null,
    backdrop = null,
    year = null,
    rating = null,
    duration = null,
    episodeTitle = null,
    overview = null,
    addedByName = null
  } = {}) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) throw new Error('Destination chat not registered.');

    const queueId = `q_${randomUUID().slice(0, 12)}`;
    const normSeason = season != null && season !== '' ? Number(season) : null;
    const normEpisode = episode != null && episode !== '' ? Number(episode) : null;

    // Prevent duplicate queue inserts
    const existing = this.db.get(
      `SELECT id, queue_item_id, position FROM cinema_queue_items 
       WHERE destination_id = ? AND media_id = ? AND (season IS ? OR season = ?) AND (episode IS ? OR episode = ?) AND status = 'queued'`,
      dest.id, String(mediaId), normSeason, normSeason, normEpisode, normEpisode
    );
    if (existing) {
      if (playNext && existing.position > 1) {
        this.moveToTop(numChat, existing.queue_item_id);
        return { ok: true, queueId: existing.queue_item_id, position: 1, title, updated: true };
      }
      return { ok: false, message: 'Item is already in the queue.', queueId: existing.queue_item_id };
    }

    let position = 1;
    if (playNext) {
      this.db.run(
        `UPDATE cinema_queue_items SET position = position + 1 
         WHERE destination_id = ? AND status = 'queued'`,
        dest.id
      );
      position = 1;
    } else {
      const maxRow = this.db.get(
        `SELECT MAX(position) as max_pos FROM cinema_queue_items 
         WHERE destination_id = ? AND status = 'queued'`,
        dest.id
      );
      position = (maxRow?.max_pos || 0) + 1;
    }

    const metaObj = { poster, backdrop, year, rating, duration, episodeTitle, overview, addedByName };
    this.itemMeta.set(queueId, metaObj);

    try {
      this.db.run(
        `INSERT INTO cinema_queue_items 
         (destination_id, queue_item_id, media_type, media_id, title, season, episode, position, origin, added_by, status, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'queued', ?)`,
        dest.id, queueId, mediaType, String(mediaId), title, normSeason, normEpisode, position, Number(addedByUserId || 0), JSON.stringify(metaObj)
      );
    } catch {
      this.db.run(
        `INSERT INTO cinema_queue_items 
         (destination_id, queue_item_id, media_type, media_id, title, season, episode, position, origin, added_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'queued')`,
        dest.id, queueId, mediaType, String(mediaId), title, normSeason, normEpisode, position, Number(addedByUserId || 0)
      );
    }

    return {
      ok: true,
      queueId,
      queueItemId: queueId,
      position,
      title
    };
  }

  async addSeasonToQueue(chatId, {
    mediaId,
    title,
    seriesTitle,
    season = 1,
    episodes = [],
    poster = null,
    backdrop = null,
    year = null,
    rating = null,
    addedByUserId = 0
  } = {}) {
    let epList = Array.isArray(episodes) ? episodes : [];
    if (epList.length === 0 && this.api?.getTvSeason) {
      const seasonData = await this.api.getTvSeason(mediaId, season).catch(() => null);
      if (Array.isArray(seasonData?.episodes)) {
        epList = seasonData.episodes;
      }
    }
    const baseTitle = title || seriesTitle;
    const added = [];
    for (const ep of epList) {
      const epNum = ep.episode_number ?? ep.episode;
      if (epNum == null) continue;
      const res = await this.addToQueue(chatId, {
        mediaType: 'tv',
        mediaId,
        title: baseTitle || ep.title || `Episode ${epNum}`,
        season: Number(season),
        episode: Number(epNum),
        episodeTitle: ep.title || ep.name || `Episode ${epNum}`,
        poster: ep.thumbnail || poster,
        backdrop,
        year,
        rating,
        duration: ep.runtime ? Number(ep.runtime) * 60 : null,
        overview: ep.overview || null,
        addedByUserId,
        playNext: false
      });
      if (res.ok) added.push(res);
    }
    return { ok: true, addedCount: added.length, items: added };
  }

  removeFromQueue(chatId, queueItemId) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) return false;

    this.db.run(
      `UPDATE cinema_queue_items SET status = 'removed' 
       WHERE destination_id = ? AND queue_item_id = ?`,
      dest.id, queueItemId
    );
    this.itemMeta.delete(queueItemId);

    this.#reindexQueue(dest.id);
    return true;
  }

  moveQueueItem(chatId, queueItemId, direction) {
    if (direction === 'top') return this.moveToTop(chatId, queueItemId);
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) return false;

    const item = this.db.get(
      `SELECT id, position FROM cinema_queue_items 
       WHERE destination_id = ? AND queue_item_id = ? AND status = 'queued'`,
      dest.id, queueItemId
    );
    if (!item) return false;

    const currentPos = item.position;
    const targetPos = direction === 'up' ? currentPos - 1 : currentPos + 1;
    if (targetPos < 1) return false;

    const neighbor = this.db.get(
      `SELECT id, position FROM cinema_queue_items 
       WHERE destination_id = ? AND position = ? AND status = 'queued'`,
      dest.id, targetPos
    );
    if (!neighbor) return false;

    this.db.run('UPDATE cinema_queue_items SET position = ? WHERE id = ?', targetPos, item.id);
    this.db.run('UPDATE cinema_queue_items SET position = ? WHERE id = ?', currentPos, neighbor.id);
    return true;
  }

  moveToTop(chatId, queueItemId) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) return false;

    const item = this.db.get(
      `SELECT id, position FROM cinema_queue_items 
       WHERE destination_id = ? AND queue_item_id = ? AND status = 'queued'`,
      dest.id, queueItemId
    );
    if (!item) return false;
    if (item.position === 1) return true;

    this.db.run(
      `UPDATE cinema_queue_items SET position = position + 1 
       WHERE destination_id = ? AND status = 'queued' AND position < ?`,
      dest.id, item.position
    );
    this.db.run('UPDATE cinema_queue_items SET position = 1 WHERE id = ?', item.id);
    this.#reindexQueue(dest.id);
    return true;
  }

  reorderQueue(chatId, orderedQueueItemIds = []) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest || !Array.isArray(orderedQueueItemIds)) return false;

    const rows = this.db.all(
      `SELECT id, queue_item_id FROM cinema_queue_items 
       WHERE destination_id = ? AND status = 'queued' ORDER BY position ASC`,
      dest.id
    ) || [];

    const byQueueId = new Map(rows.map(r => [r.queue_item_id, r.id]));
    const seen = new Set();
    let pos = 1;

    for (const qId of orderedQueueItemIds) {
      const dbId = byQueueId.get(qId);
      if (dbId && !seen.has(qId)) {
        seen.add(qId);
        this.db.run('UPDATE cinema_queue_items SET position = ? WHERE id = ?', pos++, dbId);
      }
    }

    for (const r of rows) {
      if (!seen.has(r.queue_item_id)) {
        this.db.run('UPDATE cinema_queue_items SET position = ? WHERE id = ?', pos++, r.id);
      }
    }

    return true;
  }

  clearQueue(chatId) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) return false;

    this.db.run(
      `UPDATE cinema_queue_items SET status = 'removed' 
       WHERE destination_id = ? AND status = 'queued'`,
      dest.id
    );
    return true;
  }

  #reindexQueue(destinationId) {
    const rows = this.db.all(
      `SELECT id FROM cinema_queue_items 
       WHERE destination_id = ? AND status = 'queued' 
       ORDER BY position ASC`,
      destinationId
    );
    let pos = 1;
    for (const r of rows || []) {
      this.db.run('UPDATE cinema_queue_items SET position = ? WHERE id = ?', pos++, r.id);
    }
  }

  async getNextItem(chatId) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) return null;

    const item = this.db.get(
      `SELECT * FROM cinema_queue_items 
       WHERE destination_id = ? AND status = 'queued' 
       ORDER BY position ASC LIMIT 1`,
      dest.id
    );
    return this.#enrichRow(item);
  }

  async resolveNextEpisode(tvId, currentSeason, currentEpisode) {
    try {
      const sNum = parseInt(currentSeason, 10);
      const eNum = parseInt(currentEpisode, 10);
      if (!this.api?.getTvEpisode) return null;

      // 1. Check if current episode metadata has explicit next_episode pointer
      const currentEp = await this.api.getTvEpisode(tvId, sNum, eNum).catch(() => null);
      if (currentEp?.next_episode?.season_number != null && currentEp?.next_episode?.episode_number != null) {
        const nextS = Number(currentEp.next_episode.season_number);
        const nextE = Number(currentEp.next_episode.episode_number);
        const targetEp = await this.api.getTvEpisode(tvId, nextS, nextE).catch(() => null);
        return {
          mediaType: 'tv',
          mediaId: String(tvId),
          season: nextS,
          episode: nextE,
          title: targetEp?.title || targetEp?.name || `Season ${nextS} Episode ${nextE}`
        };
      }

      // 2. Check if next episode in same season exists
      const nextEp = await this.api.getTvEpisode(tvId, sNum, eNum + 1).catch(() => null);
      if (nextEp && (nextEp.id || nextEp.title || nextEp.name || nextEp.episode_number)) {
        return {
          mediaType: 'tv',
          mediaId: String(tvId),
          season: sNum,
          episode: eNum + 1,
          title: nextEp.title || nextEp.name || `Episode ${eNum + 1}`
        };
      }

      // 3. Check season transition (season + 1, episode 1)
      const nextSeasonEp1 = await this.api.getTvEpisode(tvId, sNum + 1, 1).catch(() => null);
      if (nextSeasonEp1 && (nextSeasonEp1.id || nextSeasonEp1.title || nextSeasonEp1.name || nextSeasonEp1.episode_number)) {
        return {
          mediaType: 'tv',
          mediaId: String(tvId),
          season: sNum + 1,
          episode: 1,
          title: nextSeasonEp1.title || nextSeasonEp1.name || `Season ${sNum + 1} Episode 1`
        };
      }
    } catch (err) {
      this.log.warn({ err: err?.message, tvId, currentSeason, currentEpisode }, 'Failed to resolve next TV episode');
    }
    return null;
  }

  async resolvePrevEpisode(tvId, currentSeason, currentEpisode) {
    try {
      const sNum = parseInt(currentSeason, 10);
      const eNum = parseInt(currentEpisode, 10);
      if (!this.api?.getTvEpisode) return null;

      const currentEp = await this.api.getTvEpisode(tvId, sNum, eNum).catch(() => null);
      if (currentEp?.prev_episode?.season_number != null && currentEp?.prev_episode?.episode_number != null) {
        const prevS = Number(currentEp.prev_episode.season_number);
        const prevE = Number(currentEp.prev_episode.episode_number);
        const targetEp = await this.api.getTvEpisode(tvId, prevS, prevE).catch(() => null);
        return {
          mediaType: 'tv',
          mediaId: String(tvId),
          season: prevS,
          episode: prevE,
          title: targetEp?.title || targetEp?.name || `Season ${prevS} Episode ${prevE}`
        };
      }

      if (eNum > 1) {
        const prevEp = await this.api.getTvEpisode(tvId, sNum, eNum - 1).catch(() => null);
        if (prevEp) {
          return {
            mediaType: 'tv',
            mediaId: String(tvId),
            season: sNum,
            episode: eNum - 1,
            title: prevEp.title || prevEp.name || `Episode ${eNum - 1}`
          };
        }
      }
    } catch {}
    return null;
  }
}
