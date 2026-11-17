import { randomBytes } from 'node:crypto';
import { RichMessageBuilder, rt } from '../telegram/rich.js';
import { getBotOwnerIds } from '../telegram/permissions.js';
import { logger } from '../core/logger.js';

export const STAR_PRODUCTS = {
  broadcast_single: {
    kind: 'broadcast_single',
    settingKey: 'cinema.starsBroadcastSinglePrice',
    defaultPrice: 25,
    title: 'Cinema Broadcast Boost',
    description: 'Broadcast your group watch party once to all opt-in Lancy cinema viewers.',
    durationMs: null
  },
  broadcast_24h: {
    kind: 'broadcast_24h',
    settingKey: 'cinema.starsBroadcast24hPrice',
    defaultPrice: 75,
    title: '24h Group Broadcast Pass',
    description: 'Unlimited cinema VC broadcasts for this group for 24 hours.',
    durationMs: 24 * 60 * 60 * 1000
  },
  vip_7d: {
    kind: 'vip_7d',
    settingKey: 'cinema.starsVip7dPrice',
    defaultPrice: 250,
    title: '7-Day VIP Cinema Pass',
    description: '7 days of unlimited group broadcasts + VIP priority status.',
    durationMs: 7 * 24 * 60 * 60 * 1000
  }
};

export class StarsBillingService {
  constructor({ app, db, settings, log } = {}) {
    this.app = app;
    this.db = db || app?.db || null;
    this.settings = settings || app?.settings || null;
    this.log = log || logger().child({ module: 'stars-billing' });
  }

  getPrice(productKind) {
    const spec = STAR_PRODUCTS[productKind];
    if (!spec) return null;
    const raw = Number(this.settings?.get?.(spec.settingKey));
    if (Number.isFinite(raw) && raw >= 1) return Math.round(raw);
    return spec.defaultPrice;
  }

  isStarsEnabled() {
    return this.settings?.get?.('cinema.starsEnabled') !== false;
  }

  isBroadcastGated() {
    return this.settings?.get?.('cinema.requireStarsForGcBroadcast') === true;
  }

  getFreeChats() {
    const list = this.settings?.get?.('cinema.freeBroadcastChats');
    if (!Array.isArray(list)) return new Set();
    return new Set(list.map((x) => String(x).trim()).filter(Boolean));
  }

  isChatExempt(chatId, initiatorUserId = null) {
    if (!this.isStarsEnabled() || !this.isBroadcastGated()) return true;
    if (initiatorUserId != null) {
      const owners = this.app ? getBotOwnerIds(this.app) : new Set();
      if (owners.has(Number(initiatorUserId))) return true;
    }
    return this.getFreeChats().has(String(Number(chatId)));
  }

  getActivePass(chatId) {
    if (!this.db?.get) return null;
    const cid = Number(chatId);
    const now = Date.now();
    return this.db.get(
      `SELECT * FROM star_payments
       WHERE chat_id = ?
         AND status = 'paid'
         AND (
           (product_kind IN ('broadcast_24h', 'vip_7d') AND (expires_at IS NULL OR expires_at > ?))
           OR product_kind = 'broadcast_single'
         )
       ORDER BY
         CASE product_kind WHEN 'vip_7d' THEN 1 WHEN 'broadcast_24h' THEN 2 ELSE 3 END,
         id DESC
       LIMIT 1`,
      cid,
      now
    ) || null;
  }

  canBroadcastChat(chatId, { initiatorUserId = null, consumeSingle = false } = {}) {
    if (this.isChatExempt(chatId, initiatorUserId)) {
      return { allowed: true, reason: 'exempt', pass: null };
    }
    const pass = this.getActivePass(chatId);
    if (!pass) {
      return { allowed: false, reason: 'stars_required', pass: null };
    }
    if (consumeSingle && pass.product_kind === 'broadcast_single' && this.db?.run) {
      this.db.run(
        `UPDATE star_payments SET status = 'used' WHERE id = ? AND status = 'paid'`,
        pass.id
      );
    }
    return { allowed: true, reason: pass.product_kind, pass };
  }

  async sendBroadcastInvoice({ api, invoiceChatId, targetChatId, payerTgId, productKind = 'broadcast_single', botId = 0, meta = {} } = {}) {
    if (!this.isStarsEnabled()) {
      throw new Error('Telegram Stars billing is currently disabled by the bot owner.');
    }
    const spec = STAR_PRODUCTS[productKind];
    if (!spec) throw new Error(`Unknown Stars product: ${productKind}`);
    const amount = this.getPrice(productKind);
    const cid = Number(targetChatId);
    const uid = Number(payerTgId);
    const payloadId = `bc:${cid}:${productKind}:${randomBytes(6).toString('hex')}`;

    if (this.db?.run) {
      this.db.run(
        `INSERT INTO star_payments (payload_id, payer_tg_id, chat_id, bot_id, product_kind, stars_amount, status, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        payloadId,
        uid,
        cid,
        Number(botId) || 0,
        productKind,
        amount,
        JSON.stringify(meta || {})
      );
    }

    const groupLabel = meta?.chatTitle ? ` (${String(meta.chatTitle).slice(0, 40)})` : '';
    const sent = await api.sendInvoice(invoiceChatId, {
      title: spec.title,
      description: `${spec.description}${groupLabel}`,
      payload: payloadId,
      currency: 'XTR',
      prices: [{ label: `${spec.title} (${amount} Stars)`, amount }]
    });
    return { ok: true, payloadId, amount, messageId: sent?.message_id || null };
  }

  async handlePreCheckout(query, api) {
    if (!query?.id) return false;
    try {
      if (query.currency !== 'XTR') {
        await api.answerPreCheckoutQuery(query.id, false, 'Only Telegram Stars (XTR) payments are accepted.');
        return false;
      }
      const payloadId = String(query.invoice_payload || '');
      const order = this.db?.get?.('SELECT * FROM star_payments WHERE payload_id = ?', payloadId);
      if (!order) {
        await api.answerPreCheckoutQuery(query.id, false, 'Invoice expired or could not be found.');
        return false;
      }
      if (order.status !== 'pending') {
        await api.answerPreCheckoutQuery(query.id, false, 'This invoice has already been processed.');
        return false;
      }
      if (Number(query.total_amount) !== Number(order.stars_amount)) {
        await api.answerPreCheckoutQuery(query.id, false, 'Stars amount mismatch. Please request a fresh invoice.');
        return false;
      }
      await api.answerPreCheckoutQuery(query.id, true);
      return true;
    } catch (err) {
      this.log.warn({ err: err?.message }, 'pre_checkout_query handling failed');
      await api.answerPreCheckoutQuery?.(query.id, false, 'Payment check failed. Please retry.').catch(() => {});
      return false;
    }
  }

  async handleSuccessfulPayment(message, api) {
    const sp = message?.successful_payment;
    if (!sp) return null;
    const payloadId = String(sp.invoice_payload || '');
    const order = this.db?.get?.('SELECT * FROM star_payments WHERE payload_id = ?', payloadId);
    if (!order) {
      this.log.warn({ payloadId }, 'received successful_payment for unknown payload');
      return null;
    }

    const spec = STAR_PRODUCTS[order.product_kind];
    const expiresAt = spec?.durationMs ? Date.now() + spec.durationMs : null;
    this.db.run(
      `UPDATE star_payments
       SET status = 'paid',
           charge_id = ?,
           provider_charge_id = ?,
           expires_at = ?
       WHERE id = ?`,
      sp.telegram_payment_charge_id || null,
      sp.provider_payment_charge_id || null,
      expiresAt,
      order.id
    );

    const updated = this.db.get('SELECT * FROM star_payments WHERE id = ?', order.id);
    let meta = {};
    try { meta = JSON.parse(order.meta_json || '{}'); } catch {}

    const targetChatId = Number(order.chat_id);
    const msgChatId = Number(message.chat?.id || order.payer_tg_id);
    if (typeof api?.sendRichMessage === 'function') {
      const card = new RichMessageBuilder()
        .bannerHeader(['⭐ STARS PASS ACTIVATED', `${spec?.title || order.product_kind}`], { size: 2 })
        .table([
          ['⭐ Paid', `${order.stars_amount} Stars`],
          ['💬 Group', meta?.chatTitle || String(targetChatId)],
          ['⏳ Validity', expiresAt ? new Date(expiresAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '1 Live Broadcast Boost'],
          ['🧾 Charge ID', String(sp.telegram_payment_charge_id || 'recorded').slice(0, 28)]
        ], { striped: true, bordered: true, compact: true })
        .paragraph(rt.text('Your cinema broadcast boost is now active!'))
        .toJSON();
      await api.sendRichMessage(msgChatId, card).catch(() => {});
    }

    // If a movie is already playing in the target chat, immediately trigger the boosted broadcast
    const qm = this.app?.musicQueueManager;
    const announcer = this.app?.cinemaAnnouncer;
    if (qm && announcer) {
      const session = qm.sessions?.get?.(targetChatId) || null;
      if (session?.currentTrack && session.currentTrack.provider === 'movie' && session.status === 'playing') {
        void announcer.onTrackStart({ chatId: targetChatId, track: session.currentTrack, session, forceBoost: true, initiatorUserId: order.payer_tg_id }).catch(() => {});
      }
    }
    return updated;
  }

  listPayments({ limit = 15 } = {}) {
    if (!this.db?.all) return [];
    return this.db.all(
      `SELECT * FROM star_payments WHERE status != 'pending' ORDER BY id DESC LIMIT ?`,
      Math.max(1, Math.min(50, Number(limit) || 15))
    );
  }

  summary() {
    if (!this.db?.get) return { totalStars: 0, paidCount: 0, refundedCount: 0 };
    const paid = this.db.get(`SELECT COALESCE(SUM(stars_amount), 0) AS s, COUNT(*) AS c FROM star_payments WHERE status IN ('paid', 'used')`) || { s: 0, c: 0 };
    const refunded = this.db.get(`SELECT COUNT(*) AS c FROM star_payments WHERE status = 'refunded'`) || { c: 0 };
    return {
      totalStars: Number(paid.s || 0),
      paidCount: Number(paid.c || 0),
      refundedCount: Number(refunded.c || 0)
    };
  }

  async refundPayment(paymentId, api) {
    const row = this.db?.get?.('SELECT * FROM star_payments WHERE id = ?', Number(paymentId));
    if (!row) throw new Error('Payment record not found.');
    if (row.status === 'refunded') throw new Error('Payment has already been refunded.');
    if (!row.charge_id) throw new Error('Missing Telegram payment charge ID for refund.');
    const useApi = api || this.app?.telegram?.api;
    if (!useApi || typeof useApi.refundStarPayment !== 'function') {
      throw new Error('Telegram refund API is unavailable.');
    }
    await useApi.refundStarPayment(row.payer_tg_id, row.charge_id);
    this.db.run(
      `UPDATE star_payments SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?`,
      row.id
    );
    return this.db.get('SELECT * FROM star_payments WHERE id = ?', row.id);
  }
}
