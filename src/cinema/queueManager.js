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
    return rows || [];
  }

  async addToQueue(chatId, {
    mediaType = 'movie',
    mediaId,
    title,
    season = null,
    episode = null,
    addedByUserId,
    playNext = false
  } = {}) {
    const numChat = Number(chatId);
    const dest = this.db.get('SELECT id FROM cinema_destinations WHERE chat_id = ?', numChat);
    if (!dest) throw new Error('Destination chat not registered.');

    const queueId = `q_${randomUUID().slice(0, 12)}`;

    // Check if already in queue
    const existing = this.db.get(
      `SELECT id FROM cinema_queue_items 
       WHERE destination_id = ? AND media_id = ? AND (season IS ? OR season = ?) AND (episode IS ? OR episode = ?) AND status = 'queued'`,
      dest.id, String(mediaId), season, season, episode, episode
    );
    if (existing) {
      return { ok: false, message: 'Item is already in the queue.' };
    }

    let position = 1;
    if (playNext) {
      // Shift existing queued items down by 1
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

    this.db.run(
      `INSERT INTO cinema_queue_items 
       (destination_id, queue_item_id, media_type, media_id, title, season, episode, position, origin, added_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'queued')`,
      dest.id, queueId, mediaType, String(mediaId), title, season, episode, position, Number(addedByUserId)
    );

    return {
      ok: true,
      queueId,
      position,
      title
    };
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

    this.#reindexQueue(dest.id);
    return true;
  }

  moveQueueItem(chatId, queueItemId, direction) {
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
    return item || null;
  }

  async resolveNextEpisode(tvId, currentSeason, currentEpisode) {
    try {
      const sNum = parseInt(currentSeason, 10);
      const eNum = parseInt(currentEpisode, 10);

      // Check if next episode in same season exists
      const nextEp = await this.api.getTvEpisode(tvId, sNum, eNum + 1).catch(() => null);
      if (nextEp && (nextEp.id || nextEp.title || nextEp.name)) {
        return {
          mediaType: 'tv',
          mediaId: String(tvId),
          season: sNum,
          episode: eNum + 1,
          title: nextEp.title || nextEp.name || `Episode ${eNum + 1}`
        };
      }

      // Check season transition (season + 1, episode 1)
      const nextSeasonEp1 = await this.api.getTvEpisode(tvId, sNum + 1, 1).catch(() => null);
      if (nextSeasonEp1 && (nextSeasonEp1.id || nextSeasonEp1.title || nextSeasonEp1.name)) {
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
}
