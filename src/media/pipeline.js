import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { validateMedia, classifyMedia } from './validate.js';
import { MediaCache } from './cache.js';
import { DedupService } from './dedup.js';
import { probeImage, probeVideo, perceptualHash, hashBundle } from './convert.js';
import { sha256Hex } from '../utils/hash.js';
import { withRetry } from '../utils/retry.js';
import { ensureDir, removeDir } from '../utils/paths.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * MediaPipeline — every downloaded media item goes through:
 *
 *   DOWNLOAD → VALIDATE → HASH → DUPLICATE CHECK → QUALITY CHECK →
 *   NORMALIZE → CACHE → CONVERT → TARGET PLATFORM VALIDATION → PUBLISH
 *
 * Nothing here blocks the Telegram event loop: callers run it inside the
 * media/pinterest/sticker queues.
 */
export class MediaPipeline {
  constructor({ db, cacheDir, settings, log } = {}) {
    this.db = db;
    this.settings = settings;
    this.log = log ?? logger().child({ module: 'media-pipeline' });
    this.cache = new MediaCache(cacheDir ?? join(process.env.DATA_DIR ?? './data', 'cache', 'media'));
    this.dedup = new DedupService(db);
    this.tmpRoot = ensureDir(settings?.get('media.temporaryStorage') ?? join(process.env.DATA_DIR ?? './data', 'tmp'));
  }

  /** Download a URL with size cap, timeout and retries. Returns a Buffer. */
  async download(url, { maxBytes, timeoutMs = 30000, signal } = {}) {
    const cap = maxBytes ?? this.settings?.get('media.maxDownloadBytes') ?? 60 * 1024 * 1024;
    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; LancyBot/1.0)',
            accept: 'image/*,video/*,*/*;q=0.8'
          },
          redirect: 'follow'
        });
        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}`);
          err.code = 'HTTP_' + response.status;
          err.retryable = response.status >= 500 || response.status === 429;
          throw err;
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength && contentLength > cap) {
          const err = new Error(`Remote file is ${contentLength} bytes (cap ${cap})`);
          err.code = 'TOO_LARGE';
          err.retryable = false;
          throw err;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > cap) {
            controller.abort();
            const err = new Error(`Download exceeded the ${cap} byte cap`);
            err.code = 'TOO_LARGE';
            err.retryable = false;
            throw err;
          }
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }, { attempts: this.settings?.get('performance.retryCount') ?? 3, shouldRetry: (e) => e.retryable !== false });
  }

  /**
   * Full pipeline for one candidate media item.
   * Returns a rich descriptor or throws LancyError with a friendly message.
   */
  async process(candidate, { userId, expectedType = null, convert = null, signal } = {}) {
    const url = candidate.url ?? candidate.mediaUrl ?? candidate.imageUrl ?? null;
    const { pinId = null, sourceUrl = null, typeHint = null } = candidate;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // 1. DOWNLOAD (skipped when the candidate already carries bytes)
    const buffer = candidate.buffer ?? await this.download(url, { signal });

    // 2. VALIDATE (magic bytes + probe)
    const expected = expectedType ?? typeHint ?? null;
    const maxBytes = this.settings?.get('media.maxDownloadBytes') ?? 60 * 1024 * 1024;
    const probe = async (buf, mime) => {
      const kind = classifyMedia(mime);
      if (kind === 'image') return probeImage(buf);
      if (kind === 'video') {
        const dir = mkdtempSync(join(tmpdir(), 'lancy-probe-'));
        try {
          const p = join(dir, 'probe.bin');
          writeFileSync(p, buf);
          return probeVideo(p, this.settings?.get('media.ffmpegPath') ?? '');
        } finally {
          removeDir(dir);
        }
      }
      return {};
    };
    let validation;
    try {
      validation = await validateMedia(buffer, { expectedType: expected, maxBytes, probe });
    } catch (error) {
      throw LancyError.wrap(error, '♡ That media file looked broken, so I skipped it.');
    }

    // 3. HASH (sha256 + perceptual hash for images)
    const { sha256, phash } = await hashBundle(buffer).catch(() => ({ sha256: sha256Hex(buffer), phash: null }));

    // 4. DUPLICATE CHECK (per-user history + global registry)
    const identities = { sha256, phash, pinId, sourceUrl, mediaUrl: url };
    const verdict = userId != null ? this.dedup.check(userId, identities) : { duplicate: false, reason: null, matchedOn: null };

    // 5. CACHE (content-addressed)
    const cachedSha = this.cache.store(buffer, {
      pinId, sourceUrl, mediaUrl: url,
      mime: validation.mime,
      width: validation.width ?? null,
      height: validation.height ?? null,
      type: validation.type
    });

    const descriptor = {
      ...candidate,
      userId,
      sha256: cachedSha,
      phash,
      mime: validation.mime,
      type: validation.type,
      width: validation.width ?? null,
      height: validation.height ?? null,
      duration: validation.duration ?? null,
      size: validation.size,
      duplicate: verdict.duplicate,
      duplicateReason: verdict.reason,
      buffer
    };

    // 6. CONVERT (optional, target-platform specific)
    if (convert && !verdict.duplicate) {
      descriptor.converted = await convert(descriptor);
    }

    return descriptor;
  }

  /** Mark a processed item as delivered (no-duplicate guarantee). */
  markDelivered(userId, descriptor, { searchId = null } = {}) {
    this.dedup.markDelivered(userId, {
      sha256: descriptor.sha256,
      phash: descriptor.phash,
      pinId: descriptor.pinId,
      sourceUrl: descriptor.sourceUrl,
      mediaUrl: descriptor.mediaUrl
    }, { searchId });
    this.dedup.registerGlobal({
      sha256: descriptor.sha256,
      phash: descriptor.phash,
      mime: descriptor.mime,
      size: descriptor.size,
      width: descriptor.width,
      height: descriptor.height
    });
  }

  /** Process many candidates with bounded concurrency. */
  async processAll(candidates, { userId, concurrency = 3, expectedType, convert, signal, onProgress } = {}) {
    const results = [];
    let done = 0;
    const queue = [...candidates];
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (queue.length > 0) {
        if (signal?.aborted) return;
        const candidate = queue.shift();
        try {
          const descriptor = await this.process(candidate, { userId, expectedType, convert, signal });
          results.push(descriptor);
        } catch (error) {
          results.push({ ...candidate, error: error.message, failed: true });
        }
        done++;
        onProgress?.({ done, total: candidates.length, last: candidate });
      }
    });
    await Promise.all(workers);
    return results;
  }
}
