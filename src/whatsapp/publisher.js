import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';
import { LancyError } from '../core/errors.js';
import { splitIntoPacks, applySplitPlan, physicalPackName } from './split.js';
import { withRetry } from '../utils/retry.js';
import { sleep } from '../utils/time.js';

/**
 * WhatsAppPublisher — turns logical Telegram sticker packs into WhatsApp
 * publications:
 *
 *   logical pack (N stickers)
 *     → split into physical packs of ≤ whatsapp.physicalStickerPackLimit
 *       (plogme enforces 60 — verified in its source)
 *     → for each selected session × channel:
 *         revalidate channel permission (never trust the cache)
 *         send pack(s) with the rendered caption
 *     → per-pack, per-channel error handling with retry/skip
 *
 * Emits progress events so the Telegram UI can render ONE live message.
 * The Telegram event loop is never blocked — this runs inside the
 * whatsapp queue as a job.
 */
export class WhatsAppPublisher extends EventEmitter {
  constructor({ db, settings, channels, log } = {}) {
    super();
    this.db = db;
    this.settings = settings;
    this.channels = channels;
    this.log = log ?? logger().child({ module: 'wa-publisher' });
  }

  /**
   * Build the full publish plan (pure — used by the preview screen AND the
   * executor, so preview and execution can never disagree).
   */
  buildPlan({ packs, sessionId, channelJids, caption }) {
    const limit = Number(this.settings?.get('whatsapp.physicalStickerPackLimit') ?? 60);
    const perPack = [];
    for (const pack of packs) {
      const splits = splitIntoPacks(pack.stickerCount, limit);
      perPack.push({
        pack,
        limit,
        physicalPacks: splits.map((s) => ({
          ...s,
          name: physicalPackName(pack.tgTitle, s.index, splits.length),
          stickerCount: s.count
        })),
        physicalCount: splits.length
      });
    }
    return {
      packs: perPack,
      sessionId,
      channelJids: [...channelJids],
      caption,
      totals: {
        logicalPacks: packs.length,
        physicalPacks: perPack.reduce((n, p) => n + p.physicalCount, 0),
        stickers: packs.reduce((n, p) => n + p.stickerCount, 0),
        destinations: channelJids.length
      }
    };
  }

  /**
   * Execute a publish plan.
   * @param {object} opts { plan, session, getStickerBytes(packId, index) → Buffer, signal, onProgress }
   */
  async publish({ plan, session, getStickerBytes, signal, onProgress } = {}) {
    const { packs, sessionId, channelJids, caption } = plan;
    if (!session?.isOnline) {
      throw new LancyError('♡ That WhatsApp session is not connected right now.', { code: 'SESSION_OFFLINE' });
    }

    // 1. Revalidate channel permissions — never trust the cache.
    onProgress?.({ stage: 'validating', channelJids });
    const revalidation = await this.channels.revalidate(session, channelJids);
    const targets = revalidation.map((r) => ({
      jid: r.jid,
      name: r.name,
      canPublish: r.canPublish,
      status: 'pending'
    }));
    this.emit('channelsValidated', targets);

    // 2. Persist the publication.
    const publicationId = this.#createPublication(plan);
    const results = {
      publicationId,
      sessionId,
      caption,
      packs: [],
      targets,
      totals: { ...plan.totals, succeeded: 0, failed: 0, skipped: 0 }
    };

    const retryCount = this.settings?.get('whatsapp.retryCount') ?? 3;
    const delayBetween = this.settings?.get('whatsapp.publishingDelayMs') ?? 1200;

    for (const packPlan of packs) {
      const packResult = {
        packId: packPlan.pack.id,
        title: packPlan.pack.tgTitle,
        stickerCount: packPlan.pack.stickerCount,
        physicalPacks: [],
        status: 'pending'
      };
      results.packs.push(packResult);

      for (const physical of packPlan.physicalPacks) {
        onProgress?.({ stage: 'preparing', pack: packResult.title, physical: physical.index + 1, total: packPlan.physicalCount });
        const physicalResult = {
          index: physical.index,
          name: physical.name,
          stickerCount: physical.count,
          status: 'pending'
        };
        packResult.physicalPacks.push(physicalResult);
        const physicalRowId = this.#createPhysicalPack(publicationId, physical, packResult.title);

        // Collect sticker bytes for this physical pack.
        const stickers = [];
        for (let i = 0; i < physical.count; i++) {
          const globalIndex = physical.start + i;
          const bytes = await getStickerBytes(packPlan.pack.id, globalIndex);
          if (!bytes) throw new LancyError(`♡ Sticker ${globalIndex + 1} of "${packResult.title}" could not be loaded.`, { code: 'STICKER_MISSING' });
          stickers.push({ buffer: bytes, emoji: ['♡'] });
        }

        // Cover = first sticker of the physical pack.
        const cover = stickers[0].buffer;

        for (const target of targets) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          onProgress?.({
            stage: 'sending',
            pack: packResult.title,
            physical: physical.index + 1,
            total: packPlan.physicalCount,
            channel: target.jid,
            channelName: target.name
          });
          if (target.canPublish === 'no') {
            target.status = 'skipped';
            target.error = 'no publishing permission';
            results.totals.skipped++;
            this.#updateTarget(publicationId, target);
            continue;
          }
          try {
            await withRetry(() => session.sendStickerPack(target.jid, {
              name: physical.name,
              publisher: this.settings?.get('stickers.creatorName') ?? 'Lancy',
              description: caption ?? '',
              cover,
              stickers
            }), {
              attempts: retryCount,
              shouldRetry: (e) => e.retryable !== false && e.code !== 'SESSION_OFFLINE'
            });
            target.status = 'sent';
            target.sentAt = new Date().toISOString();
            physicalResult.status = 'sent';
            results.totals.succeeded++;
            this.log.info({ sessionId, channel: target.jid, pack: physical.name }, 'pack published');
          } catch (error) {
            target.status = 'failed';
            target.error = friendly(error);
            target.rawError = error?.message ?? String(error); // stack/details stay out of Telegram
            physicalResult.status = 'failed';
            physicalResult.error = target.error;
            physicalResult.rawError = target.rawError;
            results.totals.failed++;
            this.log.error({ err: error, sessionId, channel: target.jid, pack: physical.name }, 'pack publish failed');
          }
          this.#updateTarget(publicationId, target);
          if (delayBetween > 0) await sleep(delayBetween);
        }
        this.#updatePhysicalPack(physicalRowId, physicalResult);
        onProgress?.({ stage: 'packDone', pack: packResult.title, physical: physical.index + 1, total: packPlan.physicalCount });
      }
      packResult.status = packResult.physicalPacks.every((p) => p.status === 'sent') ? 'sent'
        : packResult.physicalPacks.some((p) => p.status === 'sent') ? 'partial' : 'failed';
    }

    // 3. Send the caption as a message to each channel (after the packs).
    if (caption) {
      for (const target of targets) {
        if (target.status !== 'sent' && target.status !== 'skipped') continue;
        onProgress?.({ stage: 'caption', channel: target.jid, channelName: target.name });
        try {
          await withRetry(() => session.sendText(target.jid, caption), { attempts: retryCount });
        } catch (error) {
          target.captionError = friendly(error);
          this.log.warn({ err: error, channel: target.jid }, 'caption send failed');
        }
        if (delayBetween > 0) await sleep(delayBetween);
      }
    }

    const failed = results.totals.failed;
    const succeeded = results.totals.succeeded;
    const attempted = succeeded + failed;
    this.#finishPublication(publicationId, failed === 0 ? 'done' : (succeeded > 0 ? 'partial' : 'failed'));
    results.status = failed === 0 ? 'done' : (succeeded > 0 ? 'partial' : 'failed');
    results.totals.attempted = attempted;
    onProgress?.({ stage: 'done', results });
    this.emit('done', results);
    return results;
  }

  #createPublication(plan) {
    const row = this.db.run(
      `INSERT INTO wa_publications
         (user_id, pack_id, session_id, caption, stickers_total, packs_total, status, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, 'publishing', ?)`,
      plan.userId ?? null,
      plan.packs[0]?.pack.id ?? null,
      plan.sessionId,
      plan.caption ?? null,
      plan.totals.stickers,
      plan.totals.physicalPacks,
      JSON.stringify({ packIds: plan.packs.map((p) => p.pack.id), logicalPacks: plan.totals.logicalPacks })
    );
    const publicationId = Number(row.lastInsertRowid);
    for (const target of plan.channelJids) {
      this.db.run(
        'INSERT INTO wa_publication_targets (publication_id, channel_jid) VALUES (?, ?)',
        publicationId, target
      );
    }
    return publicationId;
  }

  #createPhysicalPack(publicationId, physical, title) {
    const row = this.db.run(
      `INSERT INTO wa_physical_packs (publication_id, pack_index, sticker_count, name, status)
       VALUES (?, ?, ?, ?, 'sending')`,
      publicationId, physical.index, physical.count, physical.name ?? title
    );
    return Number(row.lastInsertRowid);
  }

  #updatePhysicalPack(id, result) {
    this.db.run(
      `UPDATE wa_physical_packs SET status = ?, error = ?, sent_at = ? WHERE id = ?`,
      result.status, result.error ?? null, result.status === 'sent' ? new Date().toISOString() : null, id
    );
  }

  #updateTarget(publicationId, target) {
    this.db.run(
      `UPDATE wa_publication_targets SET status = ?, error = ?, sent_at = ?
       WHERE publication_id = ? AND channel_jid = ?`,
      target.status, target.error ?? target.captionError ?? null,
      target.sentAt ?? null, publicationId, target.jid
    );
  }

  #finishPublication(id, status) {
    this.db.run(
      `UPDATE wa_publications SET status = ?, finished_at = datetime('now') WHERE id = ?`,
      status, id
    );
  }
}

function friendly(error) {
  if (error?.code === 'SESSION_OFFLINE') return 'session went offline';
  const msg = String(error?.message ?? error);
  if (/rate|limit/i.test(msg)) return 'WhatsApp rate limit — retry later';
  if (/not-authorized|forbidden/i.test(msg)) return 'not authorized to post there';
  if (/media upload|upload/i.test(msg)) return 'media upload failed';
  return msg.length > 120 ? msg.slice(0, 119) + '…' : msg;
}
