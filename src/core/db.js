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

        CREATE TABLE IF NOT EXISTS game_seen_items (
          chat_id INTEGER NOT NULL,
          mode TEXT NOT NULL,
          item_id TEXT NOT NULL,
          seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, mode, item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_game_seen_chat_mode ON game_seen_items(chat_id, mode);

        CREATE TABLE IF NOT EXISTS game_daily_streaks (
          user_id INTEGER PRIMARY KEY,
          first_name TEXT,
          username TEXT,
          current_streak INTEGER NOT NULL DEFAULT 0,
          best_streak INTEGER NOT NULL DEFAULT 0,
          total_daily_wins INTEGER NOT NULL DEFAULT 0,
          last_completed_date TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS pokemon_captures (
          user_id INTEGER NOT NULL,
          pokemon_id INTEGER NOT NULL,
          pokemon_name TEXT NOT NULL,
          types TEXT NOT NULL DEFAULT 'Normal',
          is_shiny INTEGER NOT NULL DEFAULT 0,
          best_cp INTEGER NOT NULL DEFAULT 500,
          captures_count INTEGER NOT NULL DEFAULT 1,
          first_name TEXT,
          username TEXT,
          chat_id INTEGER,
          first_caught_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_caught_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, pokemon_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pokemon_captures_user ON pokemon_captures(user_id, best_cp DESC);
        CREATE INDEX IF NOT EXISTS idx_pokemon_captures_chat ON pokemon_captures(chat_id);
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

  getGlobalGameLeaderboard(limit = 10) {
    try {
      return this.all(
        `SELECT user_id,
                MAX(first_name) as first_name,
                MAX(username) as username,
                SUM(score) as score,
                SUM(games_won) as games_won,
                SUM(correct_answers) as correct_answers,
                MIN(fastest_ms) as fastest_ms,
                MAX(best_streak) as best_streak
         FROM game_scores
         GROUP BY user_id
         ORDER BY score DESC
         LIMIT ?`,
        Number(limit)
      );
    } catch (err) {
      logger().warn({ err }, 'failed to fetch global game leaderboard');
      return [];
    }
  }

  getSeenGameItems(chatId, mode) {
    if (!chatId || !mode) return new Set();
    try {
      const rows = this.all(
        'SELECT item_id FROM game_seen_items WHERE chat_id = ? AND mode = ? ORDER BY seen_at DESC LIMIT 600',
        Number(chatId),
        String(mode)
      );
      return new Set(rows.map((r) => String(r.item_id)));
    } catch {
      return new Set();
    }
  }

  markGameItemSeen(chatId, mode, itemId) {
    if (!chatId || !mode || !itemId) return;
    try {
      this.run(
        `INSERT INTO game_seen_items (chat_id, mode, item_id, seen_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id, mode, item_id) DO UPDATE SET seen_at = datetime('now')`,
        Number(chatId),
        String(mode),
        String(itemId)
      );
    } catch {}
  }

  clearSeenGameItems(chatId, mode) {
    if (!chatId || !mode) return;
    try {
      this.run('DELETE FROM game_seen_items WHERE chat_id = ? AND mode = ?', Number(chatId), String(mode));
    } catch {}
  }

  getDailyStreak(userId) {
    if (!userId) return { current_streak: 0, best_streak: 0, total_daily_wins: 0, last_completed_date: null };
    try {
      const row = this.get('SELECT * FROM game_daily_streaks WHERE user_id = ?', Number(userId));
      return row || { current_streak: 0, best_streak: 0, total_daily_wins: 0, last_completed_date: null };
    } catch {
      return { current_streak: 0, best_streak: 0, total_daily_wins: 0, last_completed_date: null };
    }
  }

  recordDailyCompletion(user, dateStr) {
    if (!user?.id || !dateStr) return { streak: 1, alreadyDone: false };
    try {
      const existing = this.get('SELECT * FROM game_daily_streaks WHERE user_id = ?', Number(user.id));
      if (existing?.last_completed_date === dateStr) {
        return { streak: existing.current_streak || 1, bestStreak: existing.best_streak || 1, alreadyDone: true };
      }
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const isConsecutive = existing?.last_completed_date === yesterday;
      const newStreak = isConsecutive ? (Number(existing?.current_streak || 0) + 1) : 1;
      const newBest = Math.max(Number(existing?.best_streak || 0), newStreak);
      const totalWins = Number(existing?.total_daily_wins || 0) + 1;

      this.run(
        `INSERT INTO game_daily_streaks (user_id, first_name, username, current_streak, best_streak, total_daily_wins, last_completed_date, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           first_name = COALESCE(excluded.first_name, game_daily_streaks.first_name),
           username = COALESCE(excluded.username, game_daily_streaks.username),
           current_streak = excluded.current_streak,
           best_streak = excluded.best_streak,
           total_daily_wins = excluded.total_daily_wins,
           last_completed_date = excluded.last_completed_date,
           updated_at = datetime('now')`,
        Number(user.id),
        user.first_name || 'Player',
        user.username || null,
        newStreak,
        newBest,
        totalWins,
        String(dateStr)
      );
      return { streak: newStreak, bestStreak: newBest, alreadyDone: false };
    } catch (err) {
      logger().warn({ err, userId: user?.id }, 'failed to record daily completion');
      return { streak: 1, bestStreak: 1, alreadyDone: false };
    }
  }

  getDailyStreakLeaderboard(limit = 10) {
    try {
      return this.all(
        `SELECT user_id, first_name, username, current_streak, best_streak, total_daily_wins, last_completed_date
         FROM game_daily_streaks
         ORDER BY current_streak DESC, best_streak DESC, total_daily_wins DESC
         LIMIT ?`,
        Number(limit)
      );
    } catch {
      return [];
    }
  }

  recordPokemonCapture({ user, chatId = null, pokemonId, pokemonName, types = 'Normal', isShiny = false, cp = 500 } = {}) {
    if (!user?.id || !pokemonId || !pokemonName) return null;
    try {
      const uid = Number(user.id);
      const pid = Number(pokemonId);
      const shinyInt = isShiny ? 1 : 0;
      const rolledCp = Math.max(100, Number(cp) || 500);
      const existing = this.get(
        'SELECT * FROM pokemon_captures WHERE user_id = ? AND pokemon_id = ?',
        uid,
        pid
      );
      const isNewDexEntry = !existing;
      const newBestCp = existing ? Math.max(Number(existing.best_cp || 0), rolledCp) : rolledCp;
      const newShiny = existing ? Math.max(Number(existing.is_shiny || 0), shinyInt) : shinyInt;
      const newCount = existing ? Number(existing.captures_count || 0) + 1 : 1;

      this.run(
        `INSERT INTO pokemon_captures
          (user_id, pokemon_id, pokemon_name, types, is_shiny, best_cp, captures_count, first_name, username, chat_id, first_caught_at, last_caught_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, pokemon_id) DO UPDATE SET
           pokemon_name = excluded.pokemon_name,
           types = excluded.types,
           is_shiny = MAX(pokemon_captures.is_shiny, excluded.is_shiny),
           best_cp = MAX(pokemon_captures.best_cp, excluded.best_cp),
           captures_count = pokemon_captures.captures_count + 1,
           first_name = COALESCE(excluded.first_name, pokemon_captures.first_name),
           username = COALESCE(excluded.username, pokemon_captures.username),
           chat_id = COALESCE(excluded.chat_id, pokemon_captures.chat_id),
           last_caught_at = datetime('now')`,
        uid,
        pid,
        String(pokemonName),
        Array.isArray(types) ? types.join(' / ') : String(types || 'Normal'),
        shinyInt,
        rolledCp,
        user.first_name || 'Trainer',
        user.username || null,
        chatId ? Number(chatId) : null
      );

      return {
        isNewDexEntry,
        bestCp: newBestCp,
        rolledCp,
        isShiny: Boolean(newShiny),
        capturesCount: newCount
      };
    } catch (err) {
      logger().warn({ err, userId: user?.id, pokemonId }, 'failed to record pokemon capture');
      return null;
    }
  }

  getUserPokedex(userId, limit = 15) {
    if (!userId) return [];
    try {
      return this.all(
        `SELECT * FROM pokemon_captures
         WHERE user_id = ?
         ORDER BY is_shiny DESC, best_cp DESC, captures_count DESC
         LIMIT ?`,
        Number(userId),
        Number(limit)
      );
    } catch {
      return [];
    }
  }

  getUserPokedexStats(userId) {
    if (!userId) {
      return { uniqueCount: 0, totalCaptured: 0, shinyCount: 0, topPokemon: null, rankTitle: '🎒 Rookie Trainer' };
    }
    try {
      const summary = this.get(
        `SELECT
           COUNT(*) AS unique_count,
           COALESCE(SUM(captures_count), 0) AS total_captured,
           COALESCE(SUM(CASE WHEN is_shiny = 1 THEN 1 ELSE 0 END), 0) AS shiny_count
         FROM pokemon_captures
         WHERE user_id = ?`,
        Number(userId)
      );
      const topPokemon = this.get(
        `SELECT * FROM pokemon_captures
         WHERE user_id = ?
         ORDER BY best_cp DESC, is_shiny DESC
         LIMIT 1`,
        Number(userId)
      );
      const u = Number(summary?.unique_count || 0);
      const rankTitle =
        u >= 100 ? '👑 Pokémon Grand Master'
        : u >= 50 ? '🏆 League Champion'
        : u >= 25 ? '⚜️ Elite Four'
        : u >= 10 ? '🥇 Gym Leader'
        : u >= 3 ? '⚡ Ace Trainer'
        : '🎒 Rookie Trainer';

      return {
        uniqueCount: u,
        totalCaptured: Number(summary?.total_captured || 0),
        shinyCount: Number(summary?.shiny_count || 0),
        topPokemon: topPokemon || null,
        rankTitle
      };
    } catch {
      return { uniqueCount: 0, totalCaptured: 0, shinyCount: 0, topPokemon: null, rankTitle: '🎒 Rookie Trainer' };
    }
  }

  getGroupPokedexLeaderboard(chatId, limit = 10) {
    try {
      return this.all(
        `SELECT
           user_id,
           MAX(first_name) AS first_name,
           MAX(username) AS username,
           COUNT(*) AS unique_dex,
           SUM(captures_count) AS total_caught,
           SUM(CASE WHEN is_shiny = 1 THEN 1 ELSE 0 END) AS shinies,
           MAX(best_cp) AS max_cp
         FROM pokemon_captures
         GROUP BY user_id
         ORDER BY unique_dex DESC, shinies DESC, max_cp DESC
         LIMIT ?`,
        Number(limit)
      );
    } catch {
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
