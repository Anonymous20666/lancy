import { CUSTOM_EMOJI_MAP } from '../telegram/customEmoji.js';
import { extractTelegramPackName } from './packNaming.js';
import { logger } from '../core/logger.js';

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EXTENDED_PICTO_RE = /\p{Extended_Pictographic}/u;
const REGIONAL_FLAG_RE = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const KEYCAP_RE = /^[0-9#*]\uFE0F?\u20E3$/u;

// Dark monochrome or cartoonish meme packs that turn invisible or look broken on Telegram dark cards/buttons.
export const NOISY_OR_DARK_UI_SET_NAMES = new Set([
  'StatusPackNew',
  'Emoji_fan37_by_TgEmodziBot',
  'BlackEmojiGray',
  'DarkEmoji3_by_emsetbot',
  'Earning_ON_World_by_TgEmojis_bot',
  'AlphabetEmoji',
  'darkemtgs1',
  'russian_osint',
  'finnik_donut_day_emoji'
]);

export const PREFERRED_ANIMATED_UI_SET_NAMES = new Set([
  'RestrictedEmoji',
  'NewsEmoji',
  'PremiumIcons',
  'TopicIcons',
  'EmojiStatus',
  'GameEmoji',
  'FlagsEmoji',
  'MovieIcons',
  'AdaptiveIcons',
  'AdaptiveUi',
  'NeonEmoji'
]);

export const PREFERRED_STATIC_UI_SET_NAMES = new Set([
  'InterfaceElements',
  'MusicadaptiveEmojiFTS',
  'ArrowsEmoji',
  'ControlsEmoji',
  'ShapesEmoji',
  'CirclesEmoji',
  'UiSymbols'
]);

export const PREFERRED_UI_SET_NAMES = new Set([
  ...PREFERRED_ANIMATED_UI_SET_NAMES,
  ...PREFERRED_STATIC_UI_SET_NAMES
]);

/** Normalize a Unicode emoji grapheme into a canonical lookup key (strips VS15/VS16 selectors while preserving ZWJ sequences). */
export function normalizeEmojiKey(emoji) {
  if (!emoji) return '';
  return String(emoji).trim().replace(/[\uFE0E\uFE0F]/g, '');
}

/** Return true if a grapheme represents a visual emoji (pictograph, flag pair, or keycap). */
export function isEmojiGrapheme(grapheme) {
  if (!grapheme) return false;
  return EXTENDED_PICTO_RE.test(grapheme) || REGIONAL_FLAG_RE.test(grapheme) || KEYCAP_RE.test(grapheme);
}

/**
 * Extract ordered unique standard Unicode emojis from `text`, skipping any UTF-16 ranges
 * already bound to Telegram `custom_emoji` entities.
 *
 * @param {string} text
 * @param {Array<{ offset: number, length: number }>} [excludedRanges]
 * @returns {Array<{ emoji: string, key: string, offset: number, length: number }>}
 */
export function extractUnicodeEmojis(text, excludedRanges = []) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  const seenKeys = new Set();

  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    const start = index;
    const end = index + segment.length;
    const overlapsCustom = excludedRanges.some(
      (r) => r && Number.isFinite(r.offset) && Number.isFinite(r.length) && start < (r.offset + r.length) && end > r.offset
    );
    if (overlapsCustom) continue;
    if (!isEmojiGrapheme(segment)) continue;

    const key = normalizeEmojiKey(segment);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    results.push({ emoji: segment, key, offset: start, length: segment.length });
  }
  return results;
}

/**
 * Return true strictly when a message consists solely of standard Unicode emojis and whitespace/newlines
 * (no words, commands, numbers, URLs, or Telegram custom_emoji entities).
 */
export function isPureStandardEmojiOnly(text, entities = []) {
  if (!text || typeof text !== 'string') return false;
  if (Array.isArray(entities) && entities.some((e) => e?.type === 'custom_emoji')) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  let emojiCount = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(trimmed)) {
    if (/^\s+$/u.test(segment)) continue;
    if (isEmojiGrapheme(segment)) {
      emojiCount += 1;
      continue;
    }
    return false;
  }
  return emojiCount > 0;
}

/**
 * Extract all Telegram custom emoji references from a message (entities, caption_entities,
 * custom_emoji sticker, and `t.me/addemoji/...` / `t.me/addstickers/...` links).
 */
export function extractCustomEmojiInputsFromMessage(message) {
  if (!message) return { customEmojis: [], packLinks: [] };

  const customMap = new Map(); // customEmojiId -> entry
  const packLinks = [];
  const seenPacks = new Set();

  const inspectTextAndEntities = (rawText, rawEntities) => {
    if (!rawText || !Array.isArray(rawEntities)) return;
    for (const ent of rawEntities) {
      if (ent?.type === 'custom_emoji' && ent.custom_emoji_id) {
        const id = String(ent.custom_emoji_id);
        const fallback = rawText.slice(ent.offset, ent.offset + ent.length).trim() || '✨';
        if (!customMap.has(id)) {
          customMap.set(id, {
            customEmojiId: id,
            emoji: fallback,
            key: normalizeEmojiKey(fallback) || '✨',
            setName: null,
            fileId: null,
            isVideo: false,
            isAnimated: false
          });
        }
      }
    }
  };

  inspectTextAndEntities(message.text, message.entities);
  inspectTextAndEntities(message.caption, message.caption_entities);

  if (message.sticker?.custom_emoji_id || message.sticker?.type === 'custom_emoji') {
    const st = message.sticker;
    const id = String(st.custom_emoji_id || st.file_unique_id || '');
    if (id && st.custom_emoji_id && !customMap.has(id)) {
      customMap.set(id, {
        customEmojiId: id,
        emoji: st.emoji || '✨',
        key: normalizeEmojiKey(st.emoji || '✨') || '✨',
        setName: st.set_name || null,
        fileId: st.file_id || null,
        isVideo: Boolean(st.is_video),
        isAnimated: Boolean(st.is_animated)
      });
    }
  }

  const combinedText = `${message.text || ''}\n${message.caption || ''}`;
  const urlMatches = combinedText.match(/https?:\/\/t\.me\/(?:addemoji|addstickers)\/[A-Za-z0-9_]+|t\.me\/(?:addemoji|addstickers)\/[A-Za-z0-9_]+/gi) || [];
  for (const url of urlMatches) {
    const cleanName = extractTelegramPackName(url);
    if (cleanName && !seenPacks.has(cleanName.toLowerCase())) {
      seenPacks.add(cleanName.toLowerCase());
      packLinks.push(cleanName);
    }
  }

  return {
    customEmojis: [...customMap.values()],
    packLinks
  };
}

/**
 * Chunked Telegram `getCustomEmojiStickers` lookup (Bot API limit = 200 IDs per request).
 * Returns Map<customEmojiId, StickerObject>.
 */
export async function resolveEmojiMetadataChunked(api, customEmojiIds = []) {
  const result = new Map();
  if (!api?.getCustomEmojiStickers || !Array.isArray(customEmojiIds) || !customEmojiIds.length) {
    return result;
  }
  const uniqueIds = [...new Set(customEmojiIds.map((id) => String(id).trim()).filter(Boolean))];
  const CHUNK_SIZE = 200;
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const batch = uniqueIds.slice(i, i + CHUNK_SIZE);
    try {
      const stickers = await api.getCustomEmojiStickers(batch);
      if (Array.isArray(stickers)) {
        for (const st of stickers) {
          if (st?.custom_emoji_id) {
            result.set(String(st.custom_emoji_id), st);
          }
        }
      }
    } catch {
      // Best-effort metadata hydration per chunk
    }
  }
  return result;
}

/**
 * Split preformatted custom-emoji HTML lines into Telegram-safe message payloads
 * respecting both Telegram's custom_emoji entity cap (~100) and 4096-char limit.
 */
export function chunkFormattedLines(lines, { maxEntities = 80, maxChars = 3700 } = {}) {
  const chunks = [];
  let current = [];
  let entityCount = 0;
  let charCount = 0;

  for (const item of lines) {
    const lineText = typeof item === 'string' ? item : item.text;
    const lineEntities = typeof item === 'string'
      ? (lineText.match(/<tg-emoji\b/g) || []).length
      : Number(item.entities || 0);
    const addLen = lineText.length + (current.length ? 1 : 0);

    if (
      current.length > 0 &&
      (entityCount + lineEntities > maxEntities || charCount + addLen > maxChars)
    ) {
      chunks.push(current);
      current = [];
      entityCount = 0;
      charCount = 0;
    }
    current.push(item);
    entityCount += lineEntities;
    charCount += lineText.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Persistent system-wide custom emoji catalog service.
 * Bridges hardcoded CUSTOM_EMOJI_MAP builtins, bot/user packs in SQLite,
 * and live Telegram custom emoji IDs harvested via `/emojiid` & `getStickerSet`.
 */
export class CustomEmojiRegistry {
  constructor({ db, log } = {}) {
    this.db = db;
    this.log = log ?? logger().child({ module: 'custom-emoji-registry' });
    this.seeded = false;
  }

  /** Seed builtin CUSTOM_EMOJI_MAP entries and any indexed sticker_items custom emojis into `custom_emoji_catalog`. */
  seedBuiltinCatalog() {
    if (!this.db) return 0;
    const entries = [];

    for (const [emoji, id] of Object.entries(CUSTOM_EMOJI_MAP)) {
      if (!id) continue;
      entries.push({
        customEmojiId: String(id),
        unicodeEmoji: emoji,
        unicodeKey: normalizeEmojiKey(emoji) || emoji,
        setName: null,
        fileId: null,
        isVideo: false,
        isAnimated: false,
        source: 'builtin'
      });
    }

    try {
      const existingRows = this.db.all(`
        SELECT si.custom_emoji_id, si.emoji, si.file_id, si.item_format, si.type, sp.tg_short_name, sp.user_id
        FROM sticker_items si
        LEFT JOIN sticker_packs sp ON sp.id = si.pack_id
        WHERE si.custom_emoji_id IS NOT NULL AND si.custom_emoji_id != ''
      `);
      for (const r of existingRows) {
        const em = String(r.emoji || '✨').trim() || '✨';
        entries.push({
          customEmojiId: String(r.custom_emoji_id),
          unicodeEmoji: em,
          unicodeKey: normalizeEmojiKey(em) || em,
          setName: r.tg_short_name || null,
          fileId: r.file_id || null,
          isVideo: r.item_format === 'video' || r.type === 'video',
          isAnimated: r.item_format === 'animated' || r.type === 'animated',
          source: 'pack',
          addedBy: r.user_id || null
        });
      }
    } catch {
      // sticker_items may not be populated yet on fresh DBs
    }

    const inserted = this.upsertCatalogEntries(entries);
    try {
      const validIds = new Set(Object.values(CUSTOM_EMOJI_MAP).filter(Boolean).map(String));
      const builtinRows = this.db.all("SELECT custom_emoji_id FROM custom_emoji_catalog WHERE source = 'builtin'");
      for (const row of builtinRows || []) {
        if (!validIds.has(String(row.custom_emoji_id))) {
          this.db.run("DELETE FROM custom_emoji_catalog WHERE custom_emoji_id = ? AND source = 'builtin'", String(row.custom_emoji_id));
        }
      }
    } catch {}
    this.seeded = true;
    return inserted;
  }

  /** Upsert one or many custom emoji entries without overwriting higher-trust fields with nulls. */
  upsertCatalogEntries(entries = []) {
    if (!this.db || !Array.isArray(entries) || !entries.length) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO custom_emoji_catalog (
        custom_emoji_id, unicode_emoji, unicode_key, set_name, file_id,
        is_video, is_animated, source, added_by, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(custom_emoji_id) DO UPDATE SET
        unicode_emoji = COALESCE(NULLIF(excluded.unicode_emoji, '✨'), custom_emoji_catalog.unicode_emoji),
        unicode_key = COALESCE(NULLIF(excluded.unicode_key, '✨'), custom_emoji_catalog.unicode_key),
        set_name = COALESCE(excluded.set_name, custom_emoji_catalog.set_name),
        file_id = COALESCE(excluded.file_id, custom_emoji_catalog.file_id),
        is_video = CASE WHEN excluded.is_video = 1 THEN 1 ELSE custom_emoji_catalog.is_video END,
        is_animated = CASE WHEN excluded.is_animated = 1 THEN 1 ELSE custom_emoji_catalog.is_animated END,
        source = CASE
          WHEN custom_emoji_catalog.source = 'builtin' AND excluded.source != 'builtin' THEN excluded.source
          ELSE custom_emoji_catalog.source
        END,
        added_by = COALESCE(custom_emoji_catalog.added_by, excluded.added_by),
        updated_at = datetime('now')
    `);

    let count = 0;
    for (const entry of entries) {
      const id = String(entry?.customEmojiId || entry?.custom_emoji_id || '').trim();
      if (!id) continue;
      const unicodeEmoji = String(entry.unicodeEmoji || entry.unicode_emoji || entry.emoji || '✨').trim() || '✨';
      const unicodeKey = String(entry.unicodeKey || entry.unicode_key || normalizeEmojiKey(unicodeEmoji) || unicodeEmoji).trim();
      if (!unicodeKey) continue;
      stmt.run(
        id,
        unicodeEmoji,
        unicodeKey,
        entry.setName ?? entry.set_name ?? null,
        entry.fileId ?? entry.file_id ?? null,
        entry.isVideo || entry.is_video ? 1 : 0,
        entry.isAnimated || entry.is_animated ? 1 : 0,
        entry.source || 'discovered',
        entry.addedBy ?? entry.added_by ?? null
      );
      count += 1;
    }
    return count;
  }

  /** Harvest all custom_emoji items from a Telegram `getStickerSet` response into `custom_emoji_catalog`. */
  registerPackSet(set, { userId = null, source = 'pack' } = {}) {
    if (!set?.stickers?.length) return 0;
    const entries = [];
    for (const st of set.stickers) {
      if (!st?.custom_emoji_id) continue;
      const em = String(st.emoji || '✨').trim() || '✨';
      entries.push({
        customEmojiId: String(st.custom_emoji_id),
        unicodeEmoji: em,
        unicodeKey: normalizeEmojiKey(em) || em,
        setName: set.name || st.set_name || null,
        fileId: st.file_id || null,
        isVideo: Boolean(st.is_video),
        isAnimated: Boolean(st.is_animated),
        source,
        addedBy: userId ? Number(userId) : null
      });
    }
    return this.upsertCatalogEntries(entries);
  }

  /**
   * Look up all available custom emoji candidates for a Unicode emoji.
   * Ensures exact + VS16-normalized matches return in deterministic preference order,
   * prioritizing clean animated UI packs and deprioritizing/excluding dark-monochrome or meme packs.
   */
  lookupCandidates(rawEmoji, { limit = 40, excludeDarkUiSets = false, preferAnimated = false } = {}) {
    if (!this.db || !rawEmoji) return [];
    if (!this.seeded) this.seedBuiltinCatalog();

    const exact = String(rawEmoji).trim();
    const key = normalizeEmojiKey(exact);
    if (!key) return [];

    const maxRows = Math.max(Number(limit) * 3, 60);
    const rows = this.db.all(`
      SELECT custom_emoji_id, unicode_emoji, unicode_key, set_name, file_id, is_video, is_animated, source, usage_count, updated_at
      FROM custom_emoji_catalog
      WHERE unicode_key = ? OR unicode_emoji = ?
      ORDER BY
        CASE source WHEN 'user' THEN 0 WHEN 'extracted' THEN 1 WHEN 'pack' THEN 2 ELSE 3 END ASC,
        updated_at DESC,
        usage_count DESC,
        custom_emoji_id ASC
      LIMIT ?
    `, key, exact, maxRows);

    const deterministicUi = Boolean(excludeDarkUiSets || preferAnimated);
    const mapped = rows
      .filter((r) => !(excludeDarkUiSets && r.set_name && NOISY_OR_DARK_UI_SET_NAMES.has(r.set_name)))
      .map((r) => {
        const sourceRank = r.source === 'user' ? 0 : r.source === 'extracted' ? 1 : r.source === 'pack' ? 2 : 3;
        const setPenalty = !r.set_name
          ? (r.source === 'builtin' ? 2 : 3)
          : NOISY_OR_DARK_UI_SET_NAMES.has(r.set_name)
            ? 99
            : PREFERRED_ANIMATED_UI_SET_NAMES.has(r.set_name)
              ? 0
              : PREFERRED_STATIC_UI_SET_NAMES.has(r.set_name)
                ? 1
                : 2;
        const animRank = r.is_animated ? 0 : r.is_video ? 1 : 2;
        return {
          _sourceRank: sourceRank,
          _setPenalty: setPenalty,
          _animRank: animRank,
          _usage: Number(r.usage_count || 0),
          _updatedAt: String(r.updated_at || ''),
          customEmojiId: String(r.custom_emoji_id),
          unicodeEmoji: r.unicode_emoji,
          unicodeKey: r.unicode_key,
          setName: r.set_name,
          fileId: r.file_id,
          isVideo: Boolean(r.is_video),
          isAnimated: Boolean(r.is_animated),
          source: r.source
        };
      });

    mapped.sort((a, b) => {
      // Dark/broken UI packs must always sink below clean packs/builtins unless user explicitly saved them
      const aNoisy = a.source !== 'user' && a._setPenalty >= 99 ? 1 : 0;
      const bNoisy = b.source !== 'user' && b._setPenalty >= 99 ? 1 : 0;
      if (aNoisy !== bNoisy) return aNoisy - bNoisy;
      if (a._sourceRank !== b._sourceRank) return a._sourceRank - b._sourceRank;
      if (deterministicUi) {
        if (preferAnimated && a._animRank !== b._animRank) return a._animRank - b._animRank;
        if (a._setPenalty !== b._setPenalty) return a._setPenalty - b._setPenalty;
        return a.customEmojiId.localeCompare(b.customEmojiId);
      }
      if (a._setPenalty !== b._setPenalty) return a._setPenalty - b._setPenalty;
      if (a._updatedAt !== b._updatedAt) return b._updatedAt.localeCompare(a._updatedAt);
      if (a._usage !== b._usage) return b._usage - a._usage;
      return a.customEmojiId.localeCompare(b.customEmojiId);
    });

    return mapped.slice(0, Number(limit)).map(({ _sourceRank, _setPenalty, _animRank, _usage, _updatedAt, ...clean }) => clean);
  }

  /** Increment popularity counter when a suggestion is rendered or selected. */
  recordUsage(customEmojiId) {
    if (!this.db || !customEmojiId) return;
    try {
      this.db.run(
        'UPDATE custom_emoji_catalog SET usage_count = usage_count + 1 WHERE custom_emoji_id = ?',
        String(customEmojiId)
      );
    } catch {}
  }

  /** Return aggregate stats about the catalog for Studio headers & diagnostics. */
  getStats() {
    if (!this.db) return { totalIds: 0, distinctEmojis: 0 };
    if (!this.seeded) this.seedBuiltinCatalog();
    const row = this.db.get(
      'SELECT COUNT(*) AS total_ids, COUNT(DISTINCT unicode_key) AS distinct_emojis FROM custom_emoji_catalog'
    );
    return {
      totalIds: Number(row?.total_ids || 0),
      distinctEmojis: Number(row?.distinct_emojis || 0)
    };
  }

  /**
   * Synchronize builtin & pack custom emojis against the active bot's Telegram session:
   * seeds builtin catalog, refreshes custom_emoji sticker packs via getStickerSet,
   * and hydrates live metadata (file_id, set_name, format) via getCustomEmojiStickers.
   */
  async syncPremiumEmojis(api, { limitPacks = 40 } = {}) {
    if (!this.db) return { syncedPacks: 0, hydratedIds: 0, totalIds: 0 };
    this.seedBuiltinCatalog();
    let syncedPacks = 0;
    let hydratedIds = 0;

    if (typeof api?.getStickerSet === 'function') {
      try {
        const packs = this.db.all(
          "SELECT DISTINCT tg_short_name, user_id FROM sticker_packs WHERE sticker_kind = 'custom_emoji' AND tg_short_name IS NOT NULL AND tg_short_name != '' ORDER BY modified_at DESC LIMIT ?",
          Number(limitPacks)
        );
        for (const row of packs || []) {
          try {
            const set = await api.getStickerSet(row.tg_short_name);
            if (set?.stickers?.length) {
              this.registerPackSet(set, { userId: row.user_id || null, source: 'pack' });
              syncedPacks += 1;
            }
          } catch {}
        }
      } catch {}
    }

    if (typeof api?.getCustomEmojiStickers === 'function') {
      try {
        const rows = this.db.all(
          "SELECT custom_emoji_id, unicode_emoji, set_name, file_id FROM custom_emoji_catalog WHERE file_id IS NULL OR set_name IS NULL LIMIT 400"
        );
        const allIds = [...new Set([
          ...Object.values(CUSTOM_EMOJI_MAP).filter(Boolean).map(String),
          ...(rows || []).map((r) => String(r.custom_emoji_id))
        ])];
        if (allIds.length) {
          const metaMap = await resolveEmojiMetadataChunked(api, allIds);
          if (metaMap.size > 0) {
            const updates = [];
            for (const [id, st] of metaMap.entries()) {
              const em = String(st.emoji || '✨').trim() || '✨';
              updates.push({
                customEmojiId: id,
                unicodeEmoji: em,
                unicodeKey: normalizeEmojiKey(em) || em,
                setName: st.set_name || null,
                fileId: st.file_id || null,
                isVideo: Boolean(st.is_video),
                isAnimated: Boolean(st.is_animated),
                source: st.set_name ? 'pack' : 'builtin'
              });
            }
            hydratedIds = this.upsertCatalogEntries(updates);
          }
        }
      } catch {}
    }

    const stats = this.getStats();
    this.log.info({ syncedPacks, hydratedIds, totalIds: stats.totalIds, distinctEmojis: stats.distinctEmojis }, 'premium custom emoji catalog synced');
    return { syncedPacks, hydratedIds, totalIds: stats.totalIds, distinctEmojis: stats.distinctEmojis };
  }
}
