import { readFileSync, existsSync } from 'node:fs';

/** Minimal .env loader (no dependency). */
export function loadEnvFile(path = '.env') {
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
    PINTEREST_PROVIDER: process.env.PINTEREST_PROVIDER || '',
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
  };
}
