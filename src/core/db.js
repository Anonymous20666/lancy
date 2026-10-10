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

  close() {
    try {
      this.db.close();
    } catch { /* already closed */ }
  }
}
