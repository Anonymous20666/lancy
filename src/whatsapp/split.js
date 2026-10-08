/**
 * WhatsApp physical pack splitting.
 *
 * VERIFIED against plogme@2.0.7 source (lib/Utils/messages.js,
 * prepareStickerPackMessage): a WhatsApp stickerPackMessage physically holds
 * at most 60 stickers — the library throws
 *   "Sticker pack exceeds the maximum limit of 60 stickers"
 * beyond that. We do NOT bypass that limit; we split intelligently.
 *
 * The LOGICAL Telegram pack keeps its original sticker count. The WhatsApp
 * publisher emits N physical packs of ≤ limit stickers each:
 *
 *   60  → [60]
 *   61  → [60, 1]
 *   100 → [60, 40]
 *   120 → [60, 60]
 *   121 → [60, 60, 1]
 *   150 → [60, 60, 30]
 *
 * No sticker is ever duplicated to fill a pack.
 */

export const DEFAULT_WA_PACK_LIMIT = 60;

export class SplitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SplitError';
    this.code = 'BAD_SPLIT';
  }
}

/**
 * Split `total` stickers into physical packs of at most `limit` each.
 * @returns {Array<{ index: number, start: number, count: number }>} (0-based start)
 */
export function splitIntoPacks(total, limit = DEFAULT_WA_PACK_LIMIT) {
  total = Number(total);
  limit = Number(limit);
  if (!Number.isInteger(total) || total < 0) {
    throw new SplitError(`Sticker count must be a non-negative integer, got ${total}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SplitError(`Pack limit must be a positive integer, got ${limit}`);
  }
  if (total === 0) return [];

  const packs = [];
  let remaining = total;
  let start = 0;
  let index = 0;
  while (remaining > 0) {
    const count = Math.min(limit, remaining);
    packs.push({ index, start, count });
    remaining -= count;
    start += count;
    index++;
  }
  return packs;
}

/** Slice an array of items according to a split plan. */
export function applySplitPlan(items, packs) {
  return packs.map((pack) => items.slice(pack.start, pack.start + pack.count));
}

/** Pack names for the physical splits: "Name 01", "Name 02", … */
export function physicalPackName(baseName, packIndex, totalPacks) {
  const num = String(packIndex + 1).padStart(2, '0');
  return totalPacks > 1 ? `${baseName} ${num}` : baseName;
}

/** Human summary used in captions: "STICKERS • 100 / PACKS • 02". */
export function splitSummary(total, limit = DEFAULT_WA_PACK_LIMIT) {
  const packs = splitIntoPacks(total, limit);
  return {
    stickers: total,
    packs: packs.length,
    packSizes: packs.map((p) => p.count),
    limit
  };
}
