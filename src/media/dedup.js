import { logger } from '../core/logger.js';
import { isPerceptualDuplicate } from '../utils/phash.js';
import { sha256Hex } from '../utils/hash.js';

/**
 * DedupService — the GLOBAL no-duplicate system.
 *
 * A media item is a duplicate when ANY of these match:
 *   - Pinterest pin ID (same pin re-served under another URL)
 *   - canonical source URL
 *   - canonical media URL
 *   - SHA-256 of the bytes (exact content)
 *   - perceptual hash (same image, resized/re-encoded)
 *
 * History is per-user AND global, persisted in SQLite, surviving restarts.
 */
export class DedupService {
  constructor(db, { phashThreshold = 6, log } = {}) {
    this.db = db;
    this.phashThreshold = phashThreshold;
    this.log = log ?? logger().child({ module: 'dedup' });
    // Hot in-memory mirrors of the DB indexes (rebuilt lazily per user).
    this.userIndexes = new Map(); // userId -> { sha:Set, phash:[{hash, mediaId}], pin:Set, urls:Set }
  }

  #indexFor(userId) {
    const key = String(userId);
    if (!this.userIndexes.has(key)) {
      const sha = new Set();
      const pin = new Set();
      const urls = new Set();
      const phashes = [];
      for (const row of this.db.all(
        'SELECT sha256, phash, pin_id, media_url FROM user_media_history WHERE user_id = ?', userId
      )) {
        if (row.sha256) sha.add(row.sha256);
        if (row.pin_id) pin.add(row.pin_id);
        if (row.media_url) urls.add(row.media_url);
        if (row.phash) phashes.push({ hash: row.phash });
      }
      this.userIndexes.set(key, { sha, pin, urls, phashes });
    }
    return this.userIndexes.get(key);
  }

  /**
   * Check whether this candidate was already delivered to (or seen by) the
   * user. Returns { duplicate: boolean, reason: string|null, matchedOn }.
   */
  check(userId, candidate) {
    const idx = this.#indexFor(userId);
    const { sha256, phash, pinId, sourceUrl, mediaUrl } = candidate;

    if (sha256 && idx.sha.has(sha256)) return { duplicate: true, reason: 'sha256', matchedOn: sha256 };
    if (pinId && idx.pin.has(pinId)) return { duplicate: true, reason: 'pin_id', matchedOn: pinId };
    if (mediaUrl && idx.urls.has(mediaUrl)) return { duplicate: true, reason: 'media_url', matchedOn: mediaUrl };
    if (sourceUrl && idx.urls.has(sourceUrl)) return { duplicate: true, reason: 'source_url', matchedOn: sourceUrl };
    if (phash) {
      for (const entry of idx.phashes) {
        if (isPerceptualDuplicate(phash, entry.hash, { threshold: this.phashThreshold })) {
          return { duplicate: true, reason: 'perceptual_hash', matchedOn: entry.hash };
        }
      }
    }
    // Global (cross-user) exact-content check.
    if (sha256 && this.db.get('SELECT sha256 FROM media_hashes WHERE sha256 = ?', sha256)) {
      // Seen by someone else — not a per-user duplicate, but worth counting.
      this.db.run('UPDATE media_hashes SET hits = hits + 1, last_seen = datetime(\'now\') WHERE sha256 = ?', sha256);
    }
    return { duplicate: false, reason: null, matchedOn: null };
  }

  /** Record a candidate as delivered/seen for this user. */
  markDelivered(userId, candidate, { searchId = null } = {}) {
    const idx = this.#indexFor(userId);
    const { sha256, phash, pinId, sourceUrl, mediaUrl } = candidate;
    if (sha256) idx.sha.add(sha256);
    if (pinId) idx.pin.add(pinId);
    if (mediaUrl) idx.urls.add(mediaUrl);
    if (sourceUrl) idx.urls.add(sourceUrl);
    if (phash) idx.phashes.push({ hash: phash });

    this.db.run(
      `INSERT INTO user_media_history (user_id, sha256, phash, pin_id, media_url, search_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId, sha256 ?? null, phash ?? null, pinId ?? null, mediaUrl ?? sourceUrl ?? null, searchId
    );
    if (sha256) {
      this.db.run(
        `INSERT INTO media_hashes (sha256, phash) VALUES (?, ?)
         ON CONFLICT(sha256) DO UPDATE SET hits = hits + 1, last_seen = datetime('now')`,
        sha256, phash ?? null
      );
    }
  }

  /** Register content in the global hash registry (without per-user marking). */
  registerGlobal({ sha256, phash, mime, size, width, height }) {
    if (!sha256) return;
    this.db.run(
      `INSERT INTO media_hashes (sha256, phash, mime, size, width, height)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET last_seen = datetime('now'), hits = hits + 1`,
      sha256, phash ?? null, mime ?? null, size ?? null, width ?? null, height ?? null
    );
  }

  hasSeenGlobally(sha256) {
    if (!sha256) return false;
    return !!this.db.get('SELECT sha256 FROM media_hashes WHERE sha256 = ?', sha256);
  }

  stats(userId) {
    const row = this.db.get(
      'SELECT COUNT(*) AS delivered FROM user_media_history WHERE user_id = ?', userId
    );
    const global = this.db.get('SELECT COUNT(*) AS total, SUM(hits) AS hits FROM media_hashes');
    return {
      userDelivered: row?.delivered ?? 0,
      globalUnique: global?.total ?? 0,
      globalHits: global?.hits ?? 0
    };
  }

  /** Drop the in-memory index for a user (e.g. after manual history wipe). */
  invalidate(userId) {
    this.userIndexes.delete(String(userId));
  }

  /** Compute the dedup identifiers for a downloaded buffer. */
  async identify(buffer, imageHasher) {
    const sha256 = sha256Hex(buffer);
    let phash = null;
    if (imageHasher) {
      phash = await imageHasher(buffer).catch(() => null);
    }
    return { sha256, phash };
  }
}
