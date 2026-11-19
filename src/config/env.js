import { readFileSync, existsSync, mkdirSync } from 'node:fs';

/** Minimal .env loader (no dependency). */
export function loadEnvFile(path = '.env') {
  if (existsSync('/data')) {
    try {
      mkdirSync('/data/tmp', { recursive: true });
      mkdirSync('/data/cache', { recursive: true });
      if (!process.env.TMPDIR) process.env.TMPDIR = '/data/tmp';
      if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = '/data/cache';
    } catch {}
  }
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return out;
}

export function getEnv() {
  return {
    BOT_TOKEN: process.env.BOT_TOKEN || '',
    OWNER_IDS: process.env.OWNER_IDS || '',
    ADMIN_IDS: process.env.ADMIN_IDS || '',
    DATA_DIR: process.env.DATA_DIR || './data',
    FFMPEG_PATH: process.env.FFMPEG_PATH || '',
    AI_PROVIDER: process.env.AI_PROVIDER || '',
    AI_ENDPOINT: process.env.AI_ENDPOINT || '',
    AI_MODEL: process.env.AI_MODEL || '',
    AI_API_KEY: process.env.AI_API_KEY || '',
    EXPLABS_API_KEY: process.env.EXPLABS_API_KEY || '',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_LIVE_MODEL: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
    AI_BACKUP_PROVIDER: process.env.AI_BACKUP_PROVIDER || '',
    AI_BACKUP_ENDPOINT: process.env.AI_BACKUP_ENDPOINT || '',
    AI_BACKUP_MODEL: process.env.AI_BACKUP_MODEL || '',
    AI_BACKUP_API_KEY: process.env.AI_BACKUP_API_KEY || '',
    PINTEREST_PROVIDER: process.env.PINTEREST_PROVIDER || '',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    BROWSEROS_ENABLED: process.env.BROWSEROS_ENABLED ?? 'true',
    BROWSEROS_MCP_URL: process.env.BROWSEROS_MCP_URL || 'http://127.0.0.1:9010/mcp',
    BROWSEROS_BASE_URL: process.env.BROWSEROS_BASE_URL || 'http://127.0.0.1:9010',
    BROWSEROS_NOVNC_URL: process.env.BROWSEROS_NOVNC_URL || 'http://127.0.0.1:6080',
    BROWSEROS_API_TOKEN: process.env.BROWSEROS_API_TOKEN || process.env.BROWSEROS_MCP_TOKEN || '',
    BROWSEROS_CONNECTOR_MODE: process.env.BROWSEROS_CONNECTOR_MODE || 'local',
    BROWSEROS_STREAM_QUALITY: process.env.BROWSEROS_STREAM_QUALITY || 'high',
    BROWSEROS_STREAM_FPS: Number(process.env.BROWSEROS_STREAM_FPS || 12) || 12,
    BROWSEROS_STREAM_WIDTH: Number(process.env.BROWSEROS_STREAM_WIDTH || 1280) || 1280,
    BROWSEROS_STREAM_HEIGHT: Number(process.env.BROWSEROS_STREAM_HEIGHT || 720) || 720
  };
}
