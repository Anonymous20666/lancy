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
  listened_groups_json TEXT DEFAULT '[]',
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
  sticker_type TEXT NOT NULL DEFAULT 'static', -- static | video | animated | mixed
  sticker_kind TEXT NOT NULL DEFAULT 'regular', -- regular | custom_emoji
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
  custom_emoji_id TEXT,
  item_format TEXT NOT NULL DEFAULT 'static',
  source_sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_items(pack_id);
CREATE INDEX IF NOT EXISTS idx_sticker_items_emoji ON sticker_items(emoji);
CREATE INDEX IF NOT EXISTS idx_sticker_items_ceid ON sticker_items(custom_emoji_id);

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

-- Chat specific settings (e.g. custom command trigger prefix)
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id INTEGER PRIMARY KEY,
  prefix TEXT NOT NULL DEFAULT '/',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telegram channels & group chats where bot can broadcast/post
CREATE TABLE IF NOT EXISTS tg_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  username TEXT,
  chat_type TEXT NOT NULL DEFAULT 'channel',
  can_post INTEGER NOT NULL DEFAULT 1,
  added_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tg_channels_user ON tg_channels(added_by);

-- Per-bot (main + clone) admin & post permission ledger per channel
CREATE TABLE IF NOT EXISTS tg_bot_channels (
  bot_id TEXT NOT NULL,
  channel_id INTEGER NOT NULL,
  bot_username TEXT,
  is_admin INTEGER NOT NULL DEFAULT 1,
  can_post INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_tg_bot_channels_cid ON tg_bot_channels(channel_id);

-- System-wide custom emoji ID catalog (seeded builtins + packs + user lookups)
CREATE TABLE IF NOT EXISTS custom_emoji_catalog (
  custom_emoji_id TEXT PRIMARY KEY,
  unicode_emoji TEXT NOT NULL,
  unicode_key TEXT NOT NULL,
  set_name TEXT,
  file_id TEXT,
  is_video INTEGER NOT NULL DEFAULT 0,
  is_animated INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'discovered', -- builtin | pack | extracted | user
  added_by INTEGER,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ce_catalog_key ON custom_emoji_catalog(unicode_key, usage_count DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ce_catalog_set ON custom_emoji_catalog(set_name);

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
  chat_id INTEGER,
  surface TEXT NOT NULL DEFAULT 'dm',
  speaker_name TEXT,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, created_at);

-- Unified 3-scope structured memory (user private, group shared, expiring context)
CREATE TABLE IF NOT EXISTS ai_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,           -- 'user' | 'group' | 'session'
  scope_key TEXT NOT NULL,       -- String(user_id) | String(chat_id) | session_key
  user_id INTEGER,
  chat_id INTEGER,
  fact_key TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fact', -- preference | profile | movie | music | interest | group_vibe | fact
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.9,
  salience REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'inferred', -- explicit | inferred | taste | system
  access_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,            -- unix ms or NULL for durable
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope, scope_key, fact_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_memories_lookup ON ai_memories(scope, scope_key, salience DESC, updated_at DESC);

-- Short-term conversational topic & multi-speaker session tracking
CREATE TABLE IF NOT EXISTS ai_session_context (
  session_key TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  surface TEXT NOT NULL DEFAULT 'vc',
  current_topic TEXT,
  previous_topics_json TEXT NOT NULL DEFAULT '[]',
  speaker_turns_json TEXT NOT NULL DEFAULT '[]',
  unanswered_questions_json TEXT NOT NULL DEFAULT '[]',
  pending_references_json TEXT NOT NULL DEFAULT '[]',
  active_speaker_id INTEGER,
  active_speaker_name TEXT,
  mode TEXT NOT NULL DEFAULT 'IDLE',
  summary TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Autonomous scheduled sticker drops (Telegram & WhatsApp Channel Publisher)
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
  platform TEXT NOT NULL DEFAULT 'telegram', -- 'telegram' | 'whatsapp' | 'both'
  session_id TEXT,
  channel_jid TEXT,
  tg_channel_id INTEGER,
  pack_ids_json TEXT NOT NULL DEFAULT '[]',
  schedule_times_json TEXT NOT NULL DEFAULT '[]',
  content_mode TEXT NOT NULL DEFAULT 'ai', -- 'ai' | 'packs'
  custom_caption TEXT,
  ai_prompt TEXT,
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
 
-- Group Members Tracking (for /hidetag, /tagall and group mentions)
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

-- Scheduled Movie Screenings (Countdown, Hourly Re-pin, AI Lineups & Pre-warming)
CREATE TABLE IF NOT EXISTS scheduled_screenings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'movie',
  tmdb_id TEXT,
  season INTEGER,
  episode INTEGER,
  scheduled_at INTEGER NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  repin_interval_hours REAL NOT NULL DEFAULT 1,
  last_pinned_at INTEGER NOT NULL DEFAULT 0,
  last_countdown_step TEXT,
  countdown_msg_id INTEGER,
  prewarmed_json TEXT,
  ai_note TEXT,
  repeat_rule TEXT,
  boosted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | completed | cancelled | failed
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_screenings_due ON scheduled_screenings(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_screenings_chat ON scheduled_screenings(chat_id, status);

-- Telegram Stars (XTR) Paid Broadcasts & VIP Cinema Passes
CREATE TABLE IF NOT EXISTS star_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload_id TEXT NOT NULL UNIQUE,
  charge_id TEXT,
  provider_charge_id TEXT,
  payer_tg_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL DEFAULT 0,
  product_kind TEXT NOT NULL,           -- broadcast_single | broadcast_24h | vip_7d
  stars_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',  -- paid | used | refunded
  expires_at INTEGER,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  refunded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_star_payments_chat ON star_payments(chat_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_star_payments_payer ON star_payments(payer_tg_id, status);
`;
