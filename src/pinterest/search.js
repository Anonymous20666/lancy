import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { QueueManager } from '../core/queue.js';
import { isPerceptualDuplicate } from '../utils/phash.js';

/**
 * DeepSearchPipeline — a real search, not "five random images".
 *
 *   1. normalize query
 *   2. search public Pinterest results (provider)
 *   3. paginate / expand result collection (depth: quick | deep | very_deep)
 *   4. discover pins
 *   5. resolve media (provider returns best-quality URLs)
 *   6. identify image/video type
 *   7. validate media (media pipeline)
 *   8. retrieve highest-quality usable media
 *   9. normalize metadata
 *  10. deduplicate (pin id / URLs / sha256 / perceptual hash)
 *  11. compare against the user's historical results
 *  12. rank results
 *  13. return a deep result set — and keep collecting until enough VALID
 *      UNIQUE results exist, not just one full page
 */
export const SEARCH_DEPTHS = {
  quick: { pages: 1, target: 24 },
  deep: { pages: 3, target: 60 },
  very_deep: { pages: 6, target: 120 }
};

export const SEARCH_MODES = ['mixed', 'images', 'videos', 'random'];

export function normalizeQuery(query) {
  return String(query ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class DeepSearchPipeline extends EventEmitter {
  /**
   * @param {object} deps
   * @param {PinterestProvider} deps.provider
   * @param {MediaPipeline} deps.media
   * @param {object} deps.db
   * @param {object} deps.settings
   * @param {QueueManager} [deps.queues]
   */
  constructor({ provider, media, db, settings, queues, log } = {}) {
    super();
    this.provider = provider;
    this.media = media;
    this.db = db;
    this.settings = settings;
    this.queues = queues ?? new QueueManager({ pinterest: { concurrency: 2 } });
    this.log = log ?? logger().child({ module: 'pinterest-search' });
  }

  /**
   * Run a deep search.
   * @param {object} opts { userId, query, mode, depth, signal, onProgress }
   */
  async search({ userId, query, mode = 'mixed', depth = 'deep', signal, onProgress } = {}) {
    const normalized = normalizeQuery(query);
    if (!normalized) throw new LancyError('♡ Tell me what to search for.', { code: 'EMPTY_QUERY' });
    if (!SEARCH_MODES.includes(mode)) throw new LancyError(`♡ Unknown media mode: ${mode}`, { code: 'BAD_MODE' });

    const depthCfg = SEARCH_DEPTHS[depth] ?? SEARCH_DEPTHS.deep;
    const maxPages = this.settings?.get('pinterest.depthPages')?.[depth] ?? depthCfg.pages;
    const targetResults = this.settings?.get('pinterest.depthTargetResults')?.[depth] ?? depthCfg.target;
    const configuredTarget = this.settings?.get('pinterest.resultCount') ?? 0;
    const goal = Math.max(targetResults, configuredTarget);
    const maxConcurrent = Math.max(1, this.settings?.get('pinterest.maxConcurrentSearches') ?? 2);
    const timeoutMs = (this.settings?.get('pinterest.searchTimeoutSeconds') ?? 30) * 1000;

    // Persist the search record.
    const searchRow = this.db.run(
      `INSERT INTO pinterest_searches (user_id, query, normalized_query, mode, depth, result_count, duplicates_found)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
      userId, query, normalized, mode, depth
    );
    const searchId = Number(searchRow.lastInsertRowid);

    const collected = [];      // raw candidates
    const seenPins = new Set(); // pin-level dedupe across pages
    let duplicatesFound = 0;
    let bookmark = null;
    let pagesFetched = 0;

    this.emit('stage', { stage: 'searching', searchId });
    onProgress?.({ stage: 'searching', pagesFetched, collected: collected.length });

    // 2–4. Search + paginate/expand. Keep going until we have enough
    // candidates to survive validation + dedupe down to the goal.
    while (pagesFetched < maxPages) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pageTimeout = AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)) : signal;
      let page;
      try {
        page = await this.provider.search({ query: normalized, bookmark, signal: pageTimeout });
      } catch (error) {
        if (pagesFetched === 0) throw error;
        this.log.warn({ err: error, pagesFetched }, 'pagination stopped early');
        break;
      }
      pagesFetched++;
      for (const item of page.items) {
        if (seenPins.has(item.pinId)) {
          duplicatesFound++;
          continue;
        }
        seenPins.add(item.pinId);
        collected.push({ ...item, searchId });
      }
      bookmark = page.bookmark;
      onProgress?.({ stage: 'searching', pagesFetched, collected: collected.length, duplicatesFound });
      this.emit('progress', { pagesFetched, collected: collected.length });

      // Enough raw candidates to plausibly reach the goal after filtering?
      const neededRaw = Math.ceil(goal * 1.4) + 10;
      if (!bookmark || collected.length >= neededRaw) break;
    }

    // 5–6. Identify type + apply the media-mode filter.
    const modeFiltered = collected.filter((item) => {
      if (mode === 'images') return item.type === 'image';
      if (mode === 'videos') return item.type === 'video';
      return true; // mixed | random
    });

    // Random mode: shuffle for variety, then treat like mixed.
    const ordered = mode === 'random' ? shuffle(modeFiltered) : modeFiltered;

    // 7–10. Validate + hash + dedupe through the media pipeline, bounded concurrency.
    this.emit('stage', { stage: 'validating', searchId });
    onProgress?.({ stage: 'validating', total: ordered.length });

    const valid = [];
    const rejected = [];
    let processed = 0;

    const workerCount = Math.min(maxConcurrent, Math.max(1, ordered.length));
    const queue = [...ordered];
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0 && valid.length < goal) {
        if (signal?.aborted) return;
        const candidate = queue.shift();
        try {
          const descriptor = await this.media.process(candidate, {
            userId,
            expectedType: mode === 'images' ? 'image' : mode === 'videos' ? 'video' : null,
            signal
          });
          if (descriptor.duplicate) {
            duplicatesFound++;
            this.db.run(
              'UPDATE pinterest_media SET is_duplicate = 1, status = ? WHERE id = ?',
              'duplicate', descriptor.id ?? -1
            );
            continue;
          }
          descriptor.searchId = searchId;
          descriptor.id = this.#persistMedia(userId, searchId, descriptor);
          valid.push(descriptor);
        } catch (error) {
          rejected.push({ candidate, error: error.message });
        }
        processed++;
        onProgress?.({ stage: 'validating', processed, total: ordered.length, valid: valid.length, rejected: rejected.length });
      }
    });
    await Promise.all(workers);

    // 11b. Within-search content dedupe (race-free post-pass): the same bytes
    // served under a new pin id is still a duplicate — exact + perceptual.
    {
      const seenShas = new Set();
      const seenPhashes = [];
      const unique = [];
      for (const descriptor of valid) {
        let dupReason = null;
        if (descriptor.sha256 && seenShas.has(descriptor.sha256)) dupReason = 'sha256';
        else if (descriptor.phash && seenPhashes.some((h) => isPerceptualDuplicate(descriptor.phash, h))) dupReason = 'perceptual_hash';
        if (dupReason) {
          duplicatesFound++;
          descriptor.duplicate = true;
          descriptor.duplicateReason = dupReason;
          this.db.run(
            'UPDATE pinterest_media SET is_duplicate = 1, status = ? WHERE id = ?',
            'duplicate', descriptor.id ?? -1
          );
          continue;
        }
        if (descriptor.sha256) seenShas.add(descriptor.sha256);
        if (descriptor.phash) seenPhashes.push(descriptor.phash);
        unique.push(descriptor);
      }
      valid.length = 0;
      valid.push(...unique);
    }

    // 12. Rank.
    const ranked = this.rank(valid, { mode });

    // Persist search stats.
    this.db.run(
      'UPDATE pinterest_searches SET result_count = ?, duplicates_found = ? WHERE id = ?',
      ranked.length, duplicatesFound, searchId
    );

    this.emit('done', { searchId, results: ranked });
    onProgress?.({ stage: 'done', results: ranked.length });

    return {
      searchId,
      query,
      normalizedQuery: normalized,
      mode,
      depth,
      results: ranked,
      stats: {
        pagesFetched,
        collected: collected.length,
        duplicatesFound,
        rejected: rejected.length,
        valid: ranked.length
      }
    };
  }

  #persistMedia(userId, searchId, descriptor) {
    const row = this.db.run(
      `INSERT INTO pinterest_media
         (search_id, user_id, pin_id, source_url, media_url, type, width, height, duration, size, mime, sha256, phash, quality_score, is_duplicate, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'valid')`,
      searchId, userId,
      descriptor.pinId ?? null,
      descriptor.sourceUrl ?? null,
      descriptor.mediaUrl,
      descriptor.type,
      descriptor.width, descriptor.height, descriptor.duration ?? null,
      descriptor.size, descriptor.mime, descriptor.sha256, descriptor.phash,
      descriptor.qualityScore ?? 0
    );
    return Number(row.lastInsertRowid);
  }

  /**
   * Rank results: HD first, complete metadata first, larger area first.
   * Random mode keeps the shuffle.
   */
  rank(items, { mode } = {}) {
    const scored = items.map((item) => {
      let score = 0;
      const area = (item.width ?? 0) * (item.height ?? 0);
      if (item.width && item.height) {
        score += Math.min(area / (1920 * 1080), 1) * 40; // resolution
        score += item.width >= 512 && item.height >= 512 ? 10 : 0; // sticker-usable
      }
      if (item.type === 'video' && item.duration) {
        score += item.duration > 1 && item.duration <= 10 ? 10 : 0; // sticker-friendly length
      }
      if (item.mime) score += 5;
      if (item.sha256) score += 5;
      item.qualityScore = score;
      return item;
    });
    if (mode === 'random') return scored; // already shuffled upstream
    return scored.sort((a, b) => (b.qualityScore - a.qualityScore) || ((b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)));
  }

  /** Record the search's results as delivered history for the user. */
  markResultsDelivered(userId, searchId, results) {
    for (const item of results) {
      this.media.markDelivered(userId, item, { searchId });
    }
  }

  /** The user's recent searches (for "Saved / Recent Results"). */
  recentSearches(userId, limit = 10) {
    return this.db.all(
      `SELECT * FROM pinterest_searches WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      userId, limit
    );
  }

  /** Media from a previous search, ready to re-deliver. */
  resultsForSearch(userId, searchId, { limit = 60, offset = 0 } = {}) {
    return this.db.all(
      `SELECT * FROM pinterest_media WHERE user_id = ? AND search_id = ? AND status = 'valid' AND is_duplicate = 0
       ORDER BY quality_score DESC LIMIT ? OFFSET ?`,
      userId, searchId, limit, offset
    );
  }
}

export function shuffle(array) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
