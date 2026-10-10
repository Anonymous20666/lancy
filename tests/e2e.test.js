import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { MediaPipeline } from '../src/media/pipeline.js';
import { TelegramStickerService } from '../src/stickers/telegram.js';
import { StickerPackService } from '../src/stickers/packService.js';
import { toTelegramVideoSticker } from '../src/media/convert.js';
import { TELEGRAM_STICKER_LIMITS, resolveLimits } from '../src/stickers/limits.js';

function fakeSettings(overrides = {}) {
  const db = new Database(':memory:');
  const sm = new SettingsManager(db, {});
  for (const [k, v] of Object.entries(overrides)) sm.set(k, v);
  return sm;
}

async function makeImage(w = 512, h = 512, color = '#ff88aa') {
  const svg = `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${color}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function createSyntheticMp4(durationSec = 5) {
  const outPath = join(tmpdir(), `lancy_e2e_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const res = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc=duration=${durationSec}:size=640x360:rate=30`,
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    outPath
  ]);
  if (res.status !== 0 || !existsSync(outPath)) {
    throw new Error('ffmpeg failed to generate synthetic test mp4');
  }
  const { readFileSync } = import('node:fs');
  // sync read
  const buf = spawnSync('cat', [outPath]).stdout;
  try { unlinkSync(outPath); } catch {}
  return buf;
}

function makeApiMock() {
  const calls = { create: [], add: [], sets: new Map() };
  const api = {
    botUsername: 'lancybot',
    createNewStickerSet: async ({ name, title, stickers }) => {
      calls.create.push({ name, title, count: stickers.length });
      calls.sets.set(name, { name, title, stickers: stickers.map((s) => s.sticker) });
      return true;
    },
    addStickerToSet: async ({ name, sticker }) => {
      calls.add.push({ name, sticker });
      const set = calls.sets.get(name);
      if (!set) throw Object.assign(new Error('STICKERSET_INVALID'), { description: 'Bad Request: STICKERSET_INVALID' });
      if (set.stickers.length >= 120) throw Object.assign(new Error('full'), { description: 'Bad Request: STICKERS_TOO_MUCH' });
      set.stickers.push(sticker.sticker);
      return true;
    },
    setStickerSetThumbnail: async () => true,
    getStickerSet: async ({ name }) => {
      const set = calls.sets.get(name);
      if (!set) throw Object.assign(new Error('not found'), { description: 'Bad Request: STICKERSET_INVALID' });
      return { name, stickers: set.stickers.map((s, i) => ({ file_id: `file-${name}-${i}`, type: 'regular', width: 512, height: 512, emoji: '♡' })) };
    },
    getFile: async ({ file_id }) => ({ file_path: `files/${file_id}.webp` }),
    downloadFile: async () => Buffer.alloc(0)
  };
  return { api, calls };
}

// ── Test 1: Video to Sticker Strict Limits & Compression ────────────────────

test('E2E: toTelegramVideoSticker enforces Telegram limits (≤ 3.0s, ≤ 256 KB, VP9, 512px)', async () => {
  const mp4Buf = createSyntheticMp4(6); // 6 second source video
  assert.ok(mp4Buf.length > 0, 'created synthetic mp4');

  const result = await toTelegramVideoSticker(mp4Buf, {
    maxBytes: TELEGRAM_STICKER_LIMITS.video.maxBytes,
    maxDuration: 3
  });

  assert.ok(result.bytes <= 256 * 1024, `Size ${result.bytes} must be <= 256 KB (262,144 bytes)`);
  assert.ok(result.duration <= 3.05, `Duration ${result.duration} must not exceed Telegram 3.0s limit`);
  assert.equal(Math.max(result.width, result.height), 512, 'One dimension must be exactly 512px');
  assert.ok(result.buffer.slice(0, 4).toString('hex') === '1a45dfa3', 'Header must be EBML (WebM container)');
});

// ── Test 2: History retrieval is instant from storage ─────────────────────────

test('E2E: History search retrieval loads directly from SQLite in < 50ms without scraping', async () => {
  const db = new Database(':memory:');
  const userId = 8380969639;

  // Insert a past search and 20 media items
  const ins = db.run(
    'INSERT INTO pinterest_searches (user_id, query, normalized_query, mode, depth, result_count, duplicates_found) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId, 'vintage anime', 'vintage anime', 'normal', 'deep', 20, 2
  );
  const searchId = Number(ins.lastInsertRowid);

  for (let i = 0; i < 20; i++) {
    db.run(
      'INSERT INTO pinterest_media (user_id, search_id, pin_id, media_url, type, quality_score, is_duplicate, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      userId, searchId, `pin_${i}`, `https://pinimg.com/${i}.jpg`, 'image', 80 - i, 0, 'valid'
    );
  }

  const start = performance.now();
  const searchRow = db.get('SELECT * FROM pinterest_searches WHERE id = ? AND user_id = ?', searchId, userId);
  const mediaRows = db.all(
    'SELECT * FROM pinterest_media WHERE search_id = ? AND status = \'valid\' AND is_duplicate = 0 ORDER BY quality_score DESC',
    searchId
  );
  const elapsed = performance.now() - start;

  assert.ok(searchRow, 'Search row found');
  assert.equal(mediaRows.length, 20, 'All 20 cached media rows retrieved');
  assert.ok(elapsed < 50, `Retrieval took ${elapsed.toFixed(2)}ms (< 50ms)`);
  db.close();
});

// ── Test 3: Large pack creation (100 items) + Splitting at 120 ──────────────

test('E2E: 100 stickers creates 1 pack; 135 stickers cleanly splits into Pack 01 (120) and Pack 02 (15)', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'telegram.stickerAddDelayMs': 0 });
  const { api, calls } = makeApiMock();
  const media = new MediaPipeline({ db, cacheDir: join(tmpdir(), `lancy_e2e_c_${Date.now()}`), settings });
  const stickerService = new TelegramStickerService({ api, db, settings });
  const packs = new StickerPackService({ db, settings, stickerService, media });

  // 100 items: fits in 1 pack
  const descriptors100 = [];
  for (let i = 0; i < 100; i++) {
    const buffer = await makeImage(512, 512, `hsl(${i * 3},70%,50%)`);
    descriptors100.push({ pinId: `p100_${i}`, mediaUrl: `http://x/${i}.png`, type: 'image', buffer, sha256: `sha100_${i}`, phash: null });
  }

  const res100 = await packs.createPackFromMedia({ userId: 12345, query: 'coquette', descriptors: descriptors100 });
  assert.equal(res100.count, 100, 'Pack 1 contains all 100 stickers');
  assert.equal(res100.extraPacks.length, 0, 'No extra pack needed for 100 stickers');

  // 135 items: exceeds 120 -> splits into Pack 01 (120) and Pack 02 (15)
  const descriptors135 = [];
  for (let i = 0; i < 135; i++) {
    const buffer = await makeImage(512, 512, `hsl(${i * 2},60%,60%)`);
    descriptors135.push({ pinId: `p135_${i}`, mediaUrl: `http://x/${i}.png`, type: 'image', buffer, sha256: `sha135_${i}`, phash: null });
  }

  const res135 = await packs.createPackFromMedia({ userId: 12345, query: 'goth', descriptors: descriptors135 });
  assert.equal(res135.count, 120, 'Pack 01 holds exactly 120 stickers');
  assert.equal(res135.extraPacks.length, 1, 'Pack 02 created as extra split pack');
  assert.equal(res135.extraPacks[0].count, 15, 'Pack 02 holds remaining 15 stickers');
  assert.equal(res135.allPacks.length, 2, '2 total packs created and recorded');

  // Verify both packs are recorded in DB
  const dbPacks = db.all('SELECT * FROM sticker_packs WHERE user_id = 12345 AND query = \'goth\' ORDER BY id ASC');
  assert.equal(dbPacks.length, 2);
  assert.equal(dbPacks[0].count, 120);
  assert.equal(dbPacks[1].count, 15);
  db.close();
});

// ── Test 4: Video-to-Sticker Live Log Formatting & Countdown ────────────────

test('E2E: Video-to-Sticker live log displays video encoding step, countdown, and no extended blockquotes', async () => {
  const { packProgressRich } = await import('../src/telegram/screens/stickers.js');

  const videoLog = packProgressRich({
    stage: 'converting',
    count: 20,
    query: 'anime edit',
    mode: 'videos',
    done: 5,
    total: 20,
    elapsedMs: 6000
  });

  const rawJson = JSON.stringify(videoLog);

  // Must show accurate video encoding label
  assert.ok(rawJson.includes('Compressing WebM video stickers (5/20)'), 'Displays video compression step');

  // Must include countdown with seconds
  assert.ok(rawJson.includes('Countdown:'), 'Displays ticking countdown');
  assert.ok(rawJson.includes('elapsed 06s'), 'Displays accurate elapsed time');

  // Must NEVER contain extended blockquotes (blockquote with expandable/extended)
  assert.ok(!rawJson.includes('expandable_blockquote'), 'No extended blockquotes');
  assert.ok(rawJson.includes('"type":"blockquote"'), 'Uses blockquote callout formatting');
});

