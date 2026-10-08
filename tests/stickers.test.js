import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { toTelegramStaticSticker, toThumbnail, probeImage } from '../src/media/convert.js';
import { resolveLimits, validateShortName, validateTitle, buildShortName, remainingCapacity, TELEGRAM_STICKER_LIMITS } from '../src/stickers/limits.js';
import { TelegramStickerService, prepareStickerItems } from '../src/stickers/telegram.js';
import { StickerPackService } from '../src/stickers/packService.js';
import { MediaPipeline } from '../src/media/pipeline.js';
import { emojisForSticker, moodForQuery } from '../src/stickers/emoji.js';

function fakeSettings(overrides = {}) {
  const db = new Database(':memory:');
  const sm = new SettingsManager(db, {});
  for (const [k, v] of Object.entries(overrides)) sm.set(k, v);
  return sm;
}

async function makeImage(w = 1024, h = 768, color = '#ff88aa') {
  const svg = `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${color}"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 5}" fill="white"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── Conversion ──────────────────────────────────────────────────────────────

test('static sticker conversion: 512px webp within size limit', async () => {
  const input = await makeImage(1024, 768);
  const out = await toTelegramStaticSticker(input, { maxBytes: 512 * 1024, quality: 92 });
  assert.ok(out.buffer.length <= 512 * 1024);
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(Math.max(meta.width, meta.height), 512, 'one side exactly 512');
  assert.ok(Math.min(meta.width, meta.height) <= 512);
});

test('static sticker conversion handles portrait images', async () => {
  const input = await makeImage(600, 1200);
  const out = await toTelegramStaticSticker(input);
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.height, 512);
  assert.ok(meta.width <= 512);
});

test('thumbnail conversion', async () => {
  const input = await makeImage(800, 800);
  const out = await toThumbnail(input, { size: 100 });
  const meta = await sharp(out.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(Math.max(meta.width, meta.height) <= 100);
});

// ── Limits ──────────────────────────────────────────────────────────────────

test('telegram limits match the current Bot API', () => {
  assert.equal(TELEGRAM_STICKER_LIMITS.static.perSet, 120);
  assert.equal(TELEGRAM_STICKER_LIMITS.video.perSet, 50);
  assert.equal(TELEGRAM_STICKER_LIMITS.emoji.perSet, 200);
  assert.equal(TELEGRAM_STICKER_LIMITS.static.maxBytes, 512 * 1024);
});

test('resolveLimits reads settings and falls back to verified defaults', () => {
  const settings = fakeSettings();
  const limits = resolveLimits(settings, 'static');
  assert.equal(limits.perSet, 120);
  assert.equal(limits.createInitialLimit, 1, 'never create all 120 in one request');
  const custom = fakeSettings({ 'stickers.telegramStickersPerSet': 100 });
  assert.equal(resolveLimits(custom, 'static').perSet, 100);
});

test('short name validation enforces the _by_<bot> suffix', () => {
  assert.equal(validateShortName('gojo_by_lancybot', 'lancybot'), 'gojo_by_lancybot');
  assert.throws(() => validateShortName('gojo', 'lancybot'), /_by_/);
  assert.throws(() => validateShortName('Gojo_by_lancybot', 'lancybot'), /lowercase/);
  assert.throws(() => validateShortName('go__jo_by_lancybot', 'lancybot'), /consecutive/);
});

test('title validation', () => {
  assert.equal(validateTitle('Gojo Pack'), 'Gojo Pack');
  assert.throws(() => validateTitle(''), /1–64/);
  assert.throws(() => validateTitle('x'.repeat(65)), /1–64/);
});

test('buildShortName generates unique valid names', () => {
  const taken = new Set();
  const a = buildShortName({ query: 'Gojo Satoru!!', botUsername: 'LancyBot', userId: 1, taken });
  assert.match(a, /^gojo_satoru_[a-z0-9]+_by_lancybot$/);
  taken.add(a);
  const b = buildShortName({ query: 'Gojo Satoru!!', botUsername: 'LancyBot', userId: 1, taken });
  assert.notEqual(a, b);
});

test('remainingCapacity', () => {
  assert.equal(remainingCapacity(100, 120), 20);
  assert.equal(remainingCapacity(120, 120), 0);
  assert.equal(remainingCapacity(130, 120), 0);
});

// ── Emoji assignment ────────────────────────────────────────────────────────

test('emoji assignment is deterministic and mood-aware', () => {
  assert.equal(moodForQuery('gojo rage'), 'rage');
  assert.equal(moodForQuery('cute anime girl'), 'cute');
  const a = emojisForSticker({ query: 'gojo rage', index: 3 });
  const b = emojisForSticker({ query: 'gojo rage', index: 3 });
  assert.deepEqual(a, b);
  assert.ok(a.length >= 1 && a.length <= 3);
  assert.deepEqual(emojisForSticker({ query: 'x', packEmoji: '🦉', assignment: 'pack' }), ['🦉']);
});

// ── Pack service with a mocked Telegram API ─────────────────────────────────

function makeApiMock() {
  const calls = { create: [], add: [], thumb: 0, sets: new Map() };
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
    setStickerSetThumbnail: async () => { calls.thumb++; return true; },
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

test('pack service creates a pack: 1 initial + rest added one-by-one', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'telegram.stickerAddDelayMs': 0 });
  const { api, calls } = makeApiMock();
  const media = new MediaPipeline({ db, cacheDir: '/tmp/lancy-test-cache', settings });
  const stickerService = new TelegramStickerService({ api, db, settings });
  const packs = new StickerPackService({ db, settings, stickerService, media });

  // 12 fake descriptors with real image buffers
  const descriptors = [];
  for (let i = 0; i < 12; i++) {
    const buffer = await makeImage(600 + i, 600 + i, `hsl(${i * 30},70%,60%)`);
    const sha = createHash('sha256').update(buffer).digest('hex');
    media.cache.store(buffer, { mime: 'image/png' });
    descriptors.push({ pinId: `p${i}`, mediaUrl: `http://x/${i}.png`, type: 'image', buffer, sha256: sha, phash: null, width: 600 + i, height: 600 + i });
  }

  const result = await packs.createPackFromMedia({ userId: 42, query: 'gojo', descriptors });
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].count, 1, 'createNewStickerSet gets exactly 1 initial sticker');
  assert.equal(calls.add.length, 11, 'the other 11 go through addStickerToSet');
  assert.equal(result.count, 12);
  assert.match(result.link, /^https:\/\/t\.me\/addstickers\//);
  assert.match(result.name, /_by_lancybot$/);

  // DB persistence
  const row = db.get('SELECT * FROM sticker_packs WHERE id = ?', result.packId);
  assert.equal(row.count, 12);
  assert.equal(row.query, 'gojo');
  const items = db.all('SELECT * FROM sticker_items WHERE pack_id = ? ORDER BY position', result.packId);
  assert.equal(items.length, 12);
  db.close();
});

test('pack service refuses to bypass the Telegram set limit', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'telegram.stickerAddDelayMs': 0 });
  const { api } = makeApiMock();
  const media = new MediaPipeline({ db, cacheDir: '/tmp/lancy-test-cache2', settings });
  const stickerService = new TelegramStickerService({ api, db, settings });
  const packs = new StickerPackService({ db, settings, stickerService, media });

  const descriptors = [];
  for (let i = 0; i < 130; i++) {
    const buffer = await makeImage(512, 512, `hsl(${i},60%,60%)`);
    descriptors.push({ pinId: `p${i}`, mediaUrl: `http://x/${i}.png`, type: 'image', buffer, sha256: `sha-${i}`, phash: null });
  }
  const result = await packs.createPackFromMedia({ userId: 42, query: 'big', descriptors });
  assert.equal(result.count, 120, 'trimmed to the Telegram limit — never bypassed');
  db.close();
});

test('prepareStickerItems converts and assigns emojis', async () => {
  const db = new Database(':memory:');
  const settings = fakeSettings();
  const { api } = makeApiMock();
  const stickerService = new TelegramStickerService({ api, db, settings });
  const descriptors = [];
  for (let i = 0; i < 3; i++) {
    const buffer = await makeImage(700, 500, `hsl(${i * 80},70%,65%)`);
    descriptors.push({ pinId: `p${i}`, mediaUrl: `http://x/${i}.png`, type: 'image', buffer, sha256: `s${i}`, phash: null });
  }
  const items = await prepareStickerItems(descriptors, { stickerService, query: 'gojo', stickerType: 'static' });
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.ok(item.buffer.length > 0);
    assert.ok(item.emoji.length >= 1);
    const meta = await sharp(item.buffer).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(Math.max(meta.width, meta.height), 512);
  }
  db.close();
});
