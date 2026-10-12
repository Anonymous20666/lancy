import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { logger } from './logger.js';

/**
 * Thin wrapper around node:sqlite with prepared-statement caching,
 * JSON helpers and WAL mode. Single process, synchronous — perfect for a bot.
 */
export class Database {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.statements = new Map();
    this.migrate();
  }

  migrate() {
    this.db.exec(SCHEMA_SQL);
    try {
      this.db.exec('ALTER TABLE pinterest_media ADD COLUMN tg_message_id INTEGER;');
    } catch {}
    try {
      this.db.exec("ALTER TABLE wa_sessions ADD COLUMN prefix TEXT DEFAULT '.';");
    } catch {}
    try {
      this.db.exec("ALTER TABLE wa_sessions ADD COLUMN listened_groups_json TEXT DEFAULT '[]';");
    } catch {}
    try {
      this.db.exec("ALTER TABLE scheduled_drops ADD COLUMN platform TEXT DEFAULT 'telegram';");
    } catch {}
    try {
      this.db.exec('ALTER TABLE scheduled_drops ADD COLUMN tg_channel_id INTEGER;');
    } catch {}
    try {
      this.db.exec("ALTER TABLE scheduled_drops ADD COLUMN pack_ids_json TEXT DEFAULT '[]';");
    } catch {}
    try {
      this.db.exec("ALTER TABLE scheduled_drops ADD COLUMN schedule_times_json TEXT DEFAULT '[]';");
    } catch {}
    try {
      this.db.exec("ALTER TABLE scheduled_drops ADD COLUMN content_mode TEXT DEFAULT 'ai';");
    } catch {}
    try {
      this.db.exec('ALTER TABLE scheduled_drops ADD COLUMN custom_caption TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE scheduled_drops ADD COLUMN ai_prompt TEXT;');
    } catch {}
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cached_audio_tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query TEXT NOT NULL,
          file_id TEXT NOT NULL,
          title TEXT NOT NULL,
          artist TEXT,
          duration INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cached_audio_query ON cached_audio_tracks(query);

        CREATE TABLE IF NOT EXISTS cached_video_tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query TEXT NOT NULL,
          file_id TEXT NOT NULL,
          title TEXT NOT NULL,
          duration INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_cached_video_query ON cached_video_tracks(query);

        CREATE TABLE IF NOT EXISTS group_members (
          chat_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          username TEXT,
          first_name TEXT,
          last_name TEXT,
          last_seen TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_members_chat ON group_members(chat_id);

        CREATE TABLE IF NOT EXISTS game_scores (
          chat_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          first_name TEXT,
          username TEXT,
          score INTEGER NOT NULL DEFAULT 0,
          games_won INTEGER NOT NULL DEFAULT 0,
          correct_answers INTEGER NOT NULL DEFAULT 0,
          fastest_ms INTEGER DEFAULT NULL,
          best_streak INTEGER NOT NULL DEFAULT 0,
          current_streak INTEGER NOT NULL DEFAULT 0,
          last_played TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_game_scores_chat_score ON game_scores(chat_id, score DESC);

        CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id INTEGER PRIMARY KEY,
          prefix TEXT NOT NULL DEFAULT '/',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tg_channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id INTEGER NOT NULL UNIQUE,
          title TEXT NOT NULL,
          username TEXT,
          can_post INTEGER NOT NULL DEFAULT 1,
          added_by INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tg_channels_user ON tg_channels(added_by);
      `);
    } catch {}
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    const current = row ? Number(row.value) : 0;
    if (current < SCHEMA_VERSION) {
      this.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(SCHEMA_VERSION));
      logger().info({ schemaVersion: SCHEMA_VERSION }, 'database migrated');
    }
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  #sanitize(params) {
    return params.map((p) => (p === undefined ? null : p));
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...this.#sanitize(params));
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...this.#sanitize(params));
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...this.#sanitize(params));
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** JSON helpers */
  getJson(sql, ...params) {
    const row = this.get(sql, ...params);
    return row ?? null;
  }

  readJsonColumn(row, column) {
    if (!row || row[column] == null) return {};
    try {
      return JSON.parse(row[column]);
    } catch {
      return {};
    }
  }

  setSetting(key, value) {
    this.run(
      `INSERT INTO bot_settings (key, value_json, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
      key,
      JSON.stringify(value)
    );
  }

  getSetting(key, fallback = null) {
    const row = this.get('SELECT value_json FROM bot_settings WHERE key = ?', key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return fallback;
    }
  }

  getUserSetting(userId, key, fallback = undefined) {
    const row = this.get('SELECT value_json FROM user_settings WHERE user_id = ? AND key = ?', userId, key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return fallback;
    }
  }

  setUserSetting(userId, key, value) {
    this.run(
      `INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
      userId,
      key,
      JSON.stringify(value)
    );
  }

  getAllUserSettings(userId) {
    const rows = this.all('SELECT key, value_json FROM user_settings WHERE user_id = ?', userId);
    const result = {};
    for (const r of rows) {
      try {
        result[r.key] = JSON.parse(r.value_json);
      } catch {}
    }
    return result;
  }

  audit(userId, action, details = {}) {
    try {
      this.run('INSERT INTO audit_events (user_id, action, details_json) VALUES (?, ?, ?)', userId ?? null, action, JSON.stringify(details));
    } catch (error) {
      logger().warn({ error }, 'audit log failed');
    }
  }

  recordGroupMember(chatId, user) {
    if (!chatId || !user?.id || user.is_bot) return;
    try {
      this.run(
        `INSERT INTO group_members (chat_id, user_id, username, first_name, last_name, last_seen)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id, user_id) DO UPDATE SET
           username = COALESCE(excluded.username, group_members.username),
           first_name = COALESCE(excluded.first_name, group_members.first_name),
           last_name = COALESCE(excluded.last_name, group_members.last_name),
           last_seen = datetime('now')`,
        Number(chatId),
        Number(user.id),
        user.username ?? null,
        user.first_name ?? null,
        user.last_name ?? null
      );
    } catch (err) {
      logger().warn({ err, chatId, userId: user.id }, 'failed to record group member');
    }
  }

  removeGroupMember(chatId, userId) {
    if (!chatId || !userId) return;
    try {
      this.run('DELETE FROM group_members WHERE chat_id = ? AND user_id = ?', Number(chatId), Number(userId));
    } catch (err) {
      logger().warn({ err, chatId, userId }, 'failed to remove group member');
    }
  }

  getGroupMembers(chatId) {
    if (!chatId) return [];
    try {
      return this.all(
        'SELECT user_id, username, first_name, last_name, last_seen FROM group_members WHERE chat_id = ? ORDER BY last_seen DESC',
        Number(chatId)
      );
    } catch (err) {
      logger().warn({ err, chatId }, 'failed to get group members');
      return [];
    }
  }

  getGroupMemberCount(chatId) {
    if (!chatId) return 0;
    try {
      const row = this.get('SELECT COUNT(*) as count FROM group_members WHERE chat_id = ?', Number(chatId));
      return row?.count ? Number(row.count) : 0;
    } catch {
      return 0;
    }
  }

  recordGameAnswer(chatId, user, points = 100, reactionMs = null) {
    if (!chatId || !user?.id) return;
    try {
      this.run(
        `INSERT INTO game_scores (chat_id, user_id, first_name, username, score, correct_answers, current_streak, best_streak, fastest_ms, last_played)
         VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, datetime('now'))
         ON CONFLICT(chat_id, user_id) DO UPDATE SET
           first_name = COALESCE(excluded.first_name, game_scores.first_name),
           username = COALESCE(excluded.username, game_scores.username),
           score = game_scores.score + excluded.score,
           correct_answers = game_scores.correct_answers + 1,
           current_streak = game_scores.current_streak + 1,
           best_streak = MAX(game_scores.best_streak, game_scores.current_streak + 1),
           fastest_ms = CASE 
             WHEN excluded.fastest_ms IS NULL THEN game_scores.fastest_ms
             WHEN game_scores.fastest_ms IS NULL THEN excluded.fastest_ms
             ELSE MIN(game_scores.fastest_ms, excluded.fastest_ms)
           END,
           last_played = datetime('now')`,
        Number(chatId),
        Number(user.id),
        user.first_name || 'Player',
        user.username || null,
        Number(points),
        reactionMs ? Number(reactionMs) : null
      );
    } catch (err) {
      logger().warn({ err, chatId, userId: user.id }, 'failed to record game answer');
    }
  }

  recordGameWin(chatId, user) {
    if (!chatId || !user?.id) return;
    try {
      this.run(
        `INSERT INTO game_scores (chat_id, user_id, first_name, username, games_won, last_played)
         VALUES (?, ?, ?, ?, 1, datetime('now'))
         ON CONFLICT(chat_id, user_id) DO UPDATE SET
           games_won = game_scores.games_won + 1,
           last_played = datetime('now')`,
        Number(chatId),
        Number(user.id),
        user.first_name || 'Player',
        user.username || null
      );
    } catch (err) {
      logger().warn({ err, chatId, userId: user.id }, 'failed to record game win');
    }
  }

  resetPlayerStreak(chatId, userId) {
    if (!chatId || !userId) return;
    try {
      this.run('UPDATE game_scores SET current_streak = 0 WHERE chat_id = ? AND user_id = ?', Number(chatId), Number(userId));
    } catch {}
  }

  getGameLeaderboard(chatId, limit = 10) {
    if (!chatId) return [];
    try {
      return this.all(
        `SELECT user_id, first_name, username, score, games_won, correct_answers, fastest_ms, best_streak
         FROM game_scores
         WHERE chat_id = ?
         ORDER BY score DESC
         LIMIT ?`,
        Number(chatId),
        Number(limit)
      );
    } catch (err) {
      logger().warn({ err, chatId }, 'failed to fetch game leaderboard');
      return [];
    }
  }

  getChatPrefix(chatId) {
    if (!chatId) return '/';
    try {
      const row = this.get('SELECT prefix FROM chat_settings WHERE chat_id = ?', Number(chatId));
      return row?.prefix || '/';
    } catch {
      return '/';
    }
  }

  setChatPrefix(chatId, prefix = '/') {
    if (!chatId) return;
    const clean = String(prefix).trim() || '/';
    this.run(
      `INSERT INTO chat_settings (chat_id, prefix, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET prefix = excluded.prefix, updated_at = datetime('now')`,
      Number(chatId),
      clean
    );
  }

  getUserPrefix(userId) {
    if (!userId) return '/';
    return this.getUserSetting(Number(userId), 'prefix', '/');
  }

  setUserPrefix(userId, prefix = '/') {
    if (!userId) return;
    const clean = String(prefix).trim() || '/';
    this.setUserSetting(Number(userId), 'prefix', clean);
  }

  recordTelegramChannel({ channel_id, title, username = null, can_post = 1, added_by = null }) {
    if (!channel_id) return;
    const cid = Number(channel_id);
    const cleanTitle = String(title || 'Telegram Channel').trim();
    const cleanUsername = username ? String(username).replace(/^@/, '').trim() : null;
    const uid = added_by ? Number(added_by) : null;
    this.run(
      `INSERT INTO tg_channels (channel_id, title, username, can_post, added_by, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(channel_id) DO UPDATE SET
         title = excluded.title,
         username = COALESCE(excluded.username, tg_channels.username),
         can_post = excluded.can_post,
         added_by = COALESCE(excluded.added_by, tg_channels.added_by),
         updated_at = datetime('now')`,
      cid,
      cleanTitle,
      cleanUsername,
      can_post ? 1 : 0,
      uid
    );
  }

  removeTelegramChannel(channel_id) {
    if (!channel_id) return;
    this.run('DELETE FROM tg_channels WHERE channel_id = ?', Number(channel_id));
  }

  getTelegramChannels(userId = null) {
    try {
      if (userId) {
        return this.all(
          'SELECT * FROM tg_channels WHERE added_by = ? OR added_by IS NULL ORDER BY updated_at DESC',
          Number(userId)
        );
      }
      return this.all('SELECT * FROM tg_channels ORDER BY updated_at DESC');
    } catch {
      return [];
    }
  }

  getTelegramChannel(channelId) {
    if (!channelId) return null;
    try {
      return this.get('SELECT * FROM tg_channels WHERE channel_id = ?', Number(channelId)) || null;
    } catch {
      return null;
    }
  }

  close() {
    try {
      this.db.close();
    } catch { /* already closed */ }
  }
}
