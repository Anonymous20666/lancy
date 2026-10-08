/**
 * Telegram sticker limits — verified against the CURRENT Bot API and kept
 * configurable. We never hardcode a number the platform can change:
 * settings can override, and getStickerSet is used to cross-check live.
 *
 * Verified (Bot API, current):
 *   - Static sticker sets: up to 120 stickers
 *   - Emoji sticker sets:  up to 200 stickers
 *   - Video sticker sets:  up to 50 stickers
 *   - Animated (TGS) sets: up to 50 stickers
 *   - createNewStickerSet takes a LIST of initial stickers, but the initial
 *     request has its own (smaller) limit — we default to 1 and add the rest
 *     one-by-one via addStickerToSet. Never "create all 120 in one request".
 *   - Static sticker: WebP/PNG, ≤512 KB, max 512×512, one side exactly 512
 *   - Video sticker: WebM/VP9, no audio, max 512px one side exactly 512
 */
export const TELEGRAM_STICKER_LIMITS = {
  static: { perSet: 120, maxBytes: 512 * 1024, format: 'static' },
  video: { perSet: 50, maxBytes: 256 * 1024, format: 'video' },
  animated: { perSet: 50, maxBytes: 64 * 1024, format: 'animated' },
  emoji: { perSet: 200, maxBytes: 512 * 1024, format: 'static' }
};

export class StickerLimitError extends Error {
  constructor(message, code = 'LIMIT') {
    super(message);
    this.name = 'StickerLimitError';
    this.code = code;
  }
}

/** Resolve the effective limits for a sticker type from settings + defaults. */
export function resolveLimits(settings, type = 'static') {
  const base = TELEGRAM_STICKER_LIMITS[type] ?? TELEGRAM_STICKER_LIMITS.static;
  return {
    perSet: Number(settings?.get(`stickers.telegram${type[0].toUpperCase()}${type.slice(1)}StickersPerSet`))
      || (type === 'static' ? Number(settings?.get('stickers.telegramStickersPerSet')) : 0)
      || base.perSet,
    maxBytes: Number(type === 'video'
      ? settings?.get('stickers.telegramVideoMaxBytes')
      : settings?.get('stickers.telegramStaticMaxBytes')) || base.maxBytes,
    createInitialLimit: Math.max(1, Number(settings?.get('stickers.telegramCreateInitialLimit')) || 1),
    format: base.format
  };
}

/** How many stickers can still be added to an existing set. */
export function remainingCapacity(currentCount, perSet) {
  return Math.max(0, perSet - currentCount);
}

/** Validate a short name for createNewStickerSet: a-z0-9_, ends _by_<bot>. */
export function validateShortName(shortName, botUsername) {
  const name = String(shortName ?? '').trim();
  const suffix = `_by_${String(botUsername ?? '').toLowerCase()}`;
  if (!name.endsWith(suffix)) {
    throw new StickerLimitError(`Pack short names must end with ${suffix}`, 'BAD_SHORT_NAME');
  }
  const bare = name.slice(0, -suffix.length);
  if (!/^[a-z][a-z0-9_]*$/.test(bare)) {
    throw new StickerLimitError('Short names can only use lowercase letters, digits and underscores, and must start with a letter.', 'BAD_SHORT_NAME');
  }
  if (bare.includes('__')) {
    throw new StickerLimitError('Short names cannot contain consecutive underscores.', 'BAD_SHORT_NAME');
  }
  if (name.length > 64) {
    throw new StickerLimitError('Short names are limited to 64 characters.', 'BAD_SHORT_NAME');
  }
  return name;
}

export function validateTitle(title) {
  const t = String(title ?? '').trim();
  if (!t || t.length > 64) {
    throw new StickerLimitError('Pack titles must be 1–64 characters.', 'BAD_TITLE');
  }
  return t;
}

/** Build a unique short name for a query, respecting the _by_<bot> suffix. */
export function buildShortName({ query, botUsername, userId, taken = new Set() }) {
  const slug = String(query ?? 'pack')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'pack';
  const suffix = `_by_${String(botUsername ?? 'bot').toLowerCase()}`;
  const stamp = Date.now().toString(36).slice(-4);
  let base = `${slug}_${stamp}`.slice(0, 64 - suffix.length);
  let candidate = `${base}${suffix}`;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${i}${suffix}`.slice(0, 64);
    i++;
  }
  return candidate;
}
