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

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
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
