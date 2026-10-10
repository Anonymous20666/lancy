/**
 * Lancy Bot database schema (node:sqlite).
 * Everything important is persisted — no critical state lives only in memory.
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_allowed INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_states (
  tg_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  screen_message_id INTEGER,
  chat_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

-- WhatsApp sessions (credentials live on disk, isolated per session)
CREATE TABLE IF NOT EXISTS wa_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  jid TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  reconnect_state TEXT NOT NULL DEFAULT 'idle',
  creds_path TEXT NOT NULL,
  stats_json TEXT NOT NULL DEFAULT '{}',
  last_connected TEXT,
  last_disconnect TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- WhatsApp channels/newsletters cache (permissions are revalidated before publishing)
CREATE TABLE IF NOT EXISTS wa_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  channel_jid TEXT NOT NULL,
  name TEXT,
  status TEXT,
  can_publish TEXT NOT NULL DEFAULT 'unknown', -- yes | no | unknown
  can_publish_checked_at TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(session_id, channel_jid)
);

-- Pinterest searches
CREATE TABLE IF NOT EXISTS pinterest_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'normal',
  depth TEXT NOT NULL DEFAULT 'deep',
  result_count INTEGER NOT NULL DEFAULT 0,
  duplicates_found INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pinterest media candidates (per search)
CREATE TABLE IF NOT EXISTS pinterest_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  pin_id TEXT,
  source_url TEXT,
  media_url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'image', -- image | video
  width INTEGER,
  height INTEGER,
  duration REAL,
  size INTEGER,
  mime TEXT,
  sha256 TEXT,
  phash TEXT,
  quality_score REAL NOT NULL DEFAULT 0,
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | valid | rejected | delivered
  tg_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pinterest_media_search ON pinterest_media(search_id);
CREATE INDEX IF NOT EXISTS idx_pinterest_media_user ON pinterest_media(user_id);

-- Global media hash registry (survives restarts; shared across users)
CREATE TABLE IF NOT EXISTS media_hashes (
  sha256 TEXT PRIMARY KEY,
  phash TEXT,
  mime TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  hits INTEGER NOT NULL DEFAULT 0
);

-- Per-user delivered-media history (the no-duplicate guarantee)
CREATE TABLE IF NOT EXISTS user_media_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  sha256 TEXT,
  phash TEXT,
  pin_id TEXT,
  media_url TEXT,
  search_id INTEGER,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_media_history_user ON user_media_history(user_id);
CREATE INDEX IF NOT EXISTS idx_user_media_history_sha ON user_media_history(user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_user_media_history_phash ON user_media_history(user_id, phash);

-- Telegram sticker packs (logical packs)
CREATE TABLE IF NOT EXISTS sticker_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tg_short_name TEXT NOT NULL UNIQUE,
  tg_title TEXT NOT NULL,
  query TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'pinterest', -- pinterest | manual | mixed
  sticker_type TEXT NOT NULL DEFAULT 'static', -- static | video | animated
  thumb_file_id TEXT,
  link TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sticker_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  file_id TEXT,
  emoji TEXT,
  sha256 TEXT,
  phash TEXT,
  type TEXT NOT NULL DEFAULT 'static',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_items(pack_id);

-- WhatsApp publications (logical pack -> physical pack splits)
CREATE TABLE IF NOT EXISTS wa_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pack_id INTEGER REFERENCES sticker_packs(id),
  session_id TEXT NOT NULL,
  caption TEXT,
  stickers_total INTEGER NOT NULL DEFAULT 0,
  packs_total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | publishing | done | failed | cancelled
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS wa_physical_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES wa_publications(id) ON DELETE CASCADE,
  pack_index INTEGER NOT NULL,
  sticker_count INTEGER NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed
  remote_pack_id TEXT,
  error TEXT,
  sent_at TEXT
);

-- Publication destinations (channels) per publication
CREATE TABLE IF NOT EXISTS wa_publication_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES wa_publications(id) ON DELETE CASCADE,
  channel_jid TEXT NOT NULL,
  channel_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  error TEXT,
  sent_at TEXT
);

-- Job queue (persistent, survives restarts)
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, next_run_at);

-- Caption templates
CREATE TABLE IF NOT EXISTS caption_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bot settings (complete configuration system)
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_events(user_id, created_at);

-- WhatsApp Sticker Imports (staging for converting WA stickers -> Telegram packs)
CREATE TABLE IF NOT EXISTS wa_sticker_imports (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  sticker_type TEXT NOT NULL DEFAULT 'static',
  count INTEGER NOT NULL DEFAULT 1,
  data_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User-scoped settings (multi-admin isolation)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

-- AI conversation history (multi-turn memory per user)
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, created_at);

-- Autonomous scheduled sticker drops (Pinterest -> WhatsApp)
CREATE TABLE IF NOT EXISTS scheduled_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  frequency_label TEXT NOT NULL,
  times_per_day INTEGER NOT NULL DEFAULT 1,
  interval_hours INTEGER NOT NULL DEFAULT 12,
  total_days INTEGER NOT NULL DEFAULT 30,
  total_runs INTEGER NOT NULL DEFAULT 30,
  runs_completed INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  channel_jid TEXT,
  style TEXT NOT NULL DEFAULT 'girly',
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'completed' | 'cancelled'
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_drops_status ON scheduled_drops(status, next_run_at);

-- Cloned Bot Registry (Multi-tenant Bring Your Own Token)
CREATE TABLE IF NOT EXISTS cloned_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_tg_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  bot_name TEXT NOT NULL,
  bot_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | paused | error | revoked
  error_message TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cloned_bots_owner ON cloned_bots(owner_tg_id);
CREATE INDEX IF NOT EXISTS idx_cloned_bots_status ON cloned_bots(status);

-- Scoped User Audience (Per Bot & Language)
CREATE TABLE IF NOT EXISTS bot_users (
  bot_id INTEGER NOT NULL,            -- 0 = Master Lancy, >0 = cloned_bots.id
  tg_id INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',-- en, es, fr, ar, pt, ru, id
  username TEXT,
  first_name TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  is_banned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, tg_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_users_lang ON bot_users(bot_id, language);

-- Broadcast History (For bot owners to broadcast to their bot's users)
CREATE TABLE IF NOT EXISTS bot_broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  sender_tg_id INTEGER NOT NULL,
  message_text TEXT NOT NULL,
  target_language TEXT,               -- NULL for all languages, or specific lang code
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_broadcasts_bot ON bot_broadcasts(bot_id);
`;
