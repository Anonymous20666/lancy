import { EventEmitter } from 'node:events';
import pino from 'pino';
import { NEWSLETTER_MEDIA_PATH_MAP } from 'plogme';
import { logger } from '../core/logger.js';
import { friendlyDisconnectReason } from '../core/errors.js';
import { ensureSessionDir, tightenFile } from '../utils/paths.js';
import { withRetry, sleep } from '../utils/retry.js';
import { isWebPBuffer } from '../media/convert.js';


/**
 * WASession — one isolated WhatsApp account powered by plogme@2.0.7
 * (verified against the installed source):
 *
 *   import makeWASocket, { useMultiFileAuthState, DisconnectReason, delay } from 'plogme'
 *   sock.requestPairingCode(phoneNumber)   // digits only, with country code
 *   sock.ev.on('connection.update', …)     // { connection, qr, lastDisconnect }
 *   sock.ev.on('creds.update', saveCreds)
 *   sock.sendMessage(jid, { sticker: buf })                       // single sticker
 *   sock.sendMessage(jid, { stickers, cover, name, publisher,     // sticker PACK
 *                          description })                         // ≤ 60 enforced by lib
 *   sock.sendMessage(jid, { album: [...] }) / sock.sendAlbumMessage(jid, medias)
 *   sock.newsletterSubscribed() / sock.newsletterMetadata('jid', jid)
 *
 * Reconnect: on 'close', reconnect unless DisconnectReason.loggedOut.
 * Credentials persist via useMultiFileAuthState in an isolated, chmod-700
 * directory per session. Credentials are never logged, never sent to the AI,
 * never exposed in Telegram.
 */
export class WASession extends EventEmitter {
  constructor({ sessionId, name, phone, prefix, credsDir, settings, log } = {}) {
    super();
    this.sessionId = sessionId;
    this.name = name;
    this.phone = phone ?? null;
    this.prefix = prefix ?? settings?.get?.('whatsapp.prefix') ?? '.';
    this.credsDir = credsDir;
    this.settings = settings;
    this.log = log ?? logger().child({ module: 'wa-session', sessionId });
    this.sock = null;
    this.status = 'offline'; // offline | connecting | pairing | online | reconnecting | logged_out
    this.reconnectState = 'idle'; // idle | backing_off | reconnecting
    this.jid = null;
    this.lid = null;
    this.pairingCode = null;
    this.lastConnected = null;
    this.lastDisconnect = null;
    this.reconnectAttempts = 0;
    this.shouldStop = false;
    this.saveCreds = null;
    this.stats = { messagesSent: 0, packsPublished: 0, lastPublishAt: null };
  }

  getPrefix() {
    return this.prefix || '.';
  }

  setPrefix(prefix) {
    this.prefix = String(prefix).trim() || '.';
    this.emit('prefixChange', this.prefix);
  }

  /**
   * Only listen to the paired account's self-DM ("Message yourself")!
   * NEVER intercept or process messages in conversations with external contacts.
   */
  isPairedNumberDm(remoteJid) {
    if (!remoteJid) return false;
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter') || remoteJid.endsWith('@broadcast')) {
      return false;
    }
    const sessionPhone = this.phone ? String(this.phone).replace(/\D/g, '') : null;
    const sessionUser = this.jid ? this.jid.split('@')[0].split(':')[0] : null;
    const sockUser = this.sock?.user?.id ? this.sock.user.id.split('@')[0].split(':')[0] : null;
    const sockLid = (this.lid ?? this.sock?.user?.lid) ? (this.lid ?? this.sock?.user?.lid).split('@')[0].split(':')[0] : null;
    const remoteUser = remoteJid.split('@')[0].split(':')[0];

    if (sessionUser && remoteUser === sessionUser) return true;
    if (sessionPhone && remoteUser === sessionPhone) return true;
    if (sockUser && remoteUser === sockUser) return true;
    if (sockLid && remoteUser === sockLid) return true;
    return false;
  }

  get isOnline() {
    return this.status === 'online';
  }

  async start() {
    this.shouldStop = false;
    await this.#connect();
  }

  async #connect() {
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, delay, Browsers } = await import('plogme');
    this.status = this.sock ? 'reconnecting' : 'connecting';
    this.reconnectState = this.sock ? 'reconnecting' : 'idle';
    this.emit('status', this.status);

    if (this.sock) {
      try {
        this.sock.ev?.removeAllListeners?.();
        this.sock.end?.();
      } catch {}
      this.sock = null;
    }

    const dir = ensureSessionDir(this.credsDir, this.sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    this.saveCreds = (creds) => {
      // Credentials are written by plogme; tighten permissions after save.
      try {
        saveCreds(creds);
        tightenFile(`${dir}/creds.json`);
      } catch (error) {
        this.log.error({ err: error }, 'failed to save creds');
      }
    };

    const waLogger = pino({ level: this.settings?.get('logging.level') === 'debug' ? 'debug' : 'warn' });
    const messageCache = new Map();
    const cacheMsg = (m) => {
      if (m?.key?.id && m.message) {
        messageCache.set(m.key.id, m.message);
        if (messageCache.size > 200) {
          const firstKey = messageCache.keys().next().value;
          messageCache.delete(firstKey);
        }
      }
    };

    const sock = makeWASocket({
      auth: state,
      logger: waLogger,
      printQRInTerminal: false,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => {
        if (!jid) return true;
        if (jid.endsWith('@g.us')) return true;
        if (jid.endsWith('@broadcast')) return true;
        if (jid.endsWith('@newsletter')) return true;
        return false;
      },
      enableRecentMessageCache: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: true,
      getMessage: async (key) => (key?.id ? messageCache.get(key.id) : undefined),
      cachedGroupMetadata: async () => undefined,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 25000
    });
    this.sock = sock;

    // Safety guard against unhandled websocket error events
    sock.ws?.on?.('error', (err) => {
      this.log.warn({ err: err?.message }, 'whatsapp websocket error');
    });

    sock.ev.on('creds.update', this.saveCreds);

    sock.ev.on('connection.update', (update) => {
      void this.#onConnectionUpdate(update, { DisconnectReason, delay });
    });

    const processInbound = async (m) => {
      if (!m?.message || !m?.key) return;
      cacheMsg(m);

      const remoteJid = m.key.remoteJid;
      if (!remoteJid) return;

      // 1. Strictly restrict to the paired account's DM (self-chat) only!
      // NEVER process or respond to messages in conversations with external contacts!
      if (!this.isPairedNumberDm(remoteJid)) {
        return;
      }

      // 2. Strictly require an explicit text command — NEVER auto-convert without command!
      const text = extractMessageText(m.message);
      if (!text || !text.trim()) {
        return;
      }

      const prefix = this.getPrefix();
      const trimmed = text.trim();
      let matchedCmd = null;

      // Match configured prefix ONLY — when user changes prefix (e.g. ! or 😡),
      // the former prefix '.' is strictly disabled and rejected!
      if (prefix && trimmed.startsWith(prefix)) {
        const after = trimmed.slice(prefix.length).trim();
        const base = after.split(/\s+/)[0].toLowerCase();
        matchedCmd = '.' + base;
      }

      if (!matchedCmd) return;

      // Canonical command mapping
      const aliasMap = {
        '.convert': '.cv',
        '.sticker': '.s',
        '.help': '.menu'
      };
      const canonical = aliasMap[matchedCmd] || matchedCmd;

      const validCmds = new Set(['.ping', '.menu', '.cv', '.tg', '.s', '.prefix']);
      if (!validCmds.has(canonical)) {
        return;
      }

      this.log.info({ fromMe: m.key.fromMe, remoteJid, cmd: canonical }, 'wa dm command matched');
      this.emit('command', { session: this, message: m, command: canonical, text });
    };

    sock.ev.on('messages.upsert', async ({ messages }) => {
      if (!Array.isArray(messages)) return;
      for (const m of messages) {
        await processInbound(m);
      }
    });

    sock.ev.on('messages.update', async (updates) => {
      if (!Array.isArray(updates)) return;
      for (const u of updates) {
        if (u.update?.message) {
          await processInbound({ key: u.key, message: u.update.message, messageTimestamp: u.update.messageTimestamp });
        }
      }
    });

    return sock;
  }

  async #onConnectionUpdate(update, { DisconnectReason, delay }) {
    const { connection, lastDisconnect, qr } = update ?? {};
    if (qr) this.emit('qr', qr);

    if (connection === 'connecting') {
      this.status = 'connecting';
      this.emit('status', this.status);
    }

    if (connection === 'open') {
      this.status = 'online';
      this.reconnectState = 'idle';
      this.reconnectAttempts = 0;
      this.jid = sock_jid(this.sock);
      this.lid = sock_lid(this.sock);
      this.lastConnected = new Date().toISOString();
      this.emit('status', this.status);
      this.emit('online', { jid: this.jid });
      this.log.info({ sessionId: this.sessionId, jid: this.jid, lid: this.lid }, 'whatsapp session online');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
        ?? lastDisconnect?.error?.data?.statusCode
        ?? lastDisconnect?.status;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      this.status = loggedOut ? 'logged_out' : 'offline';
      this.lastDisconnect = new Date().toISOString();
      this.emit('status', this.status);
      this.emit('disconnect', { statusCode, reason: friendlyDisconnectReason(statusCode), loggedOut });
      this.log.warn({ sessionId: this.sessionId, statusCode }, 'whatsapp connection closed');

      if (loggedOut || this.shouldStop) return;
      if ((this.settings?.get('whatsapp.reconnectBehavior') ?? 'auto') !== 'auto') return;

      // Exponential backoff reconnect — never a tight loop.
      this.reconnectState = 'backing_off';
      this.reconnectAttempts++;
      const delayMs = Math.min(60000, 1000 * Math.pow(2, this.reconnectAttempts - 1));
      this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs });
      await sleep(delayMs);
      if (this.shouldStop) return;
      try {
        await this.#connect();
      } catch (error) {
        this.log.error({ err: error }, 'reconnect failed');
        this.reconnectState = 'idle';
      }
    }
  }

  /**
   * Request a pairing code. Plogme expects digits only (country code first,
   * no +). We wait for the socket to be ready, then request with retries.
   */
  async requestPairingCode(phoneDigits, customPairingCode = null) {
    const cleanedDigits = String(phoneDigits).replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(cleanedDigits)) {
      throw new Error('Pairing phone number must be digits only with country code');
    }
    this.status = 'pairing';
    this.emit('status', this.status);
    this.phone = cleanedDigits;

    const rawCustomCode = customPairingCode ?? this.settings?.get('whatsapp.customPairingCode') ?? 'LANCYBOT';
    const customCode = rawCustomCode ? String(rawCustomCode).trim().toUpperCase() : null;

    return withRetry(async (attempt) => {
      const isOpen = this.sock?.ws?.isOpen || this.sock?.ws?.readyState === 1;
      if (!this.sock || !isOpen) {
        if (this.sock) {
          try {
            this.sock.ev?.removeAllListeners?.();
            this.sock.end?.();
          } catch {}
          this.sock = null;
        }
        await this.#connect();
      }

      // Reset registered flag if stale creds exist so pairing registration can proceed cleanly
      if (this.sock.authState?.creds) {
        this.sock.authState.creds.registered = false;
      }

      // Wait until the WebSocket handshake is open and ready to accept pairing stanzas
      for (let i = 0; i < 35; i++) {
        if (this.sock?.ws?.isOpen || this.sock?.ws?.readyState === 1) break;
        await sleep(200);
      }

      if (!this.sock?.ws?.isOpen && this.sock?.ws?.readyState !== 1) {
        throw new Error('WhatsApp connection is not ready. Please try again in a few moments.');
      }

      let code;
      if (customCode && customCode.length === 8) {
        try {
          code = await this.sock.requestPairingCode(cleanedDigits, customCode);
        } catch (err) {
          this.log.warn({ err: err.message }, 'custom pairing code rejected, falling back to standard code');
          code = await this.sock.requestPairingCode(cleanedDigits);
        }
      } else {
        code = await this.sock.requestPairingCode(cleanedDigits);
      }

      this.pairingCode = code;
      this.emit('pairingCode', code);
      return code;
    }, {
      attempts: this.settings?.get('whatsapp.retryCount') ?? 3,
      baseMs: 1500,
      maxMs: 8000,
      shouldRetry: (error) => !/Pairing phone number must be digits/.test(error.message)
    });
  }

  /** Send a single sticker (webp buffer). */
  async sendSticker(jid, webpBuffer) {
    this.#assertOnline();
    await this.sock.sendMessage(jid, { sticker: webpBuffer });
    this.stats.messagesSent++;
  }

  /**
   * Send a WhatsApp sticker PACK (plogme stickerPackMessage).
   * The library physically enforces ≤ 60 stickers — the publisher splits
   * before calling this. Never bypass that limit.
   */
  async sendStickerPack(jid, { name, publisher, description, cover, stickers }) {
    this.#assertOnline();
    if (!Array.isArray(stickers) || stickers.length === 0) {
      throw new Error('sendStickerPack requires at least one sticker');
    }
    const validStickers = stickers.filter((s) => s?.buffer && isWebPBuffer(s.buffer));
    if (validStickers.length === 0) {
      throw new Error('sendStickerPack requires at least one valid WebP sticker buffer');
    }
    if (validStickers.length > 60) {
      throw new Error(`WhatsApp sticker packs physically hold at most 60 stickers (got ${validStickers.length}) — split first`);
    }
    const payload = {
      stickers: validStickers.map((s) => ({
        data: s.buffer,
        emojis: (s.emoji?.length ? s.emoji : ['🤍']).map((e) => (e === '♡' ? '🤍' : e))
      })),
      cover,
      name,
      publisher,
      description
    };

    const result = await this.sock.sendMessage(jid, payload);
    this.log.info({ sessionId: this.sessionId, jid, name }, 'sticker pack delivered');
    this.stats.messagesSent++;
    this.stats.packsPublished++;
    this.stats.lastPublishAt = new Date().toISOString();
    return result;
  }

  /** Send an album (≥2 media items) via plogme's sendAlbumMessage. */
  async sendAlbum(jid, medias) {
    this.#assertOnline();
    if (!Array.isArray(medias) || medias.length < 2) {
      throw new Error('Albums need at least two media items');
    }
    return this.sock.sendAlbumMessage(jid, medias);
  }

  /** Send a plain text message (used sparingly — WhatsApp is output-only). */
  async sendText(jid, text) {
    this.#assertOnline();
    const result = await this.sock.sendMessage(jid, { text });
    this.stats.messagesSent++;
    return result;
  }

  /** Edit an existing text message in-place on WhatsApp. */
  async editText(jid, key, text) {
    this.#assertOnline();
    const result = await this.sock.sendMessage(jid, { text, edit: key });
    this.stats.messagesSent++;
    return result;
  }

  /** Send an image with caption. */
  async sendImage(jid, buffer, caption = '') {
    this.#assertOnline();
    await this.sock.sendMessage(jid, { image: buffer, caption });
    this.stats.messagesSent++;
  }

  /** Send a video with caption. */
  async sendVideo(jid, buffer, caption = '') {
    this.#assertOnline();
    await this.sock.sendMessage(jid, { video: buffer, caption });
    this.stats.messagesSent++;
  }

  /** List newsletters/channels this account is subscribed to. */
  async listSubscribedNewsletters() {
    this.#assertOnline();
    return this.sock.newsletterSubscribed();
  }

  /** Fetch metadata for one channel (includes viewer metadata). */
  async getNewsletterMetadata(jid) {
    this.#assertOnline();
    const cleanJid = String(jid).includes('@') ? String(jid) : `${jid}@newsletter`;
    return this.sock.newsletterMetadata('jid', cleanJid);
  }

  /** Fetch metadata for a channel via invite code or public link. */
  async getNewsletterInviteInfo(codeOrUrl) {
    this.#assertOnline();
    return this.sock.newsletterGetInviteInfo(codeOrUrl);
  }

  async logout() {
    this.shouldStop = true;
    try {
      await this.sock?.logout?.('Lancy Bot logout');
    } catch { /* already closed */ }
    this.status = 'logged_out';
    this.emit('status', this.status);
  }

  async destroy() {
    this.shouldStop = true;
    try {
      this.sock?.ev?.removeAllListeners?.();
      await this.sock?.end?.();
    } catch { /* ignore */ }
    this.sock = null;
    this.status = 'offline';
  }

  #assertOnline() {
    if (!this.sock || this.status !== 'online') {
      const err = new Error(`Session "${this.name}" is ${this.status} — connect it first`);
      err.code = 'SESSION_OFFLINE';
      throw err;
    }
  }
}

function sock_jid(sock) {
  const id = sock?.authState?.creds?.me?.id ?? sock?.user?.id ?? null;
  if (!id) return null;
  // '2348012345678:12@s.whatsapp.net' → '2348012345678@s.whatsapp.net'
  return String(id).split(':')[0] + '@s.whatsapp.net';
}

export function sock_lid(sock) {
  const lid = sock?.authState?.creds?.me?.lid ?? sock?.user?.lid ?? null;
  return lid ? String(lid) : null;
}

/**
 * Recursively unpack wrapped WhatsApp message types
 * (ephemeralMessage, viewOnceMessage, documentWithCaptionMessage, deviceSentMessage, editedMessage).
 */
export function unpackMessage(message) {
  let cur = message;
  while (cur) {
    if (cur.ephemeralMessage?.message) cur = cur.ephemeralMessage.message;
    else if (cur.viewOnceMessage?.message) cur = cur.viewOnceMessage.message;
    else if (cur.viewOnceMessageV2?.message) cur = cur.viewOnceMessageV2.message;
    else if (cur.documentWithCaptionMessage?.message) cur = cur.documentWithCaptionMessage.message;
    else if (cur.deviceSentMessage?.message) cur = cur.deviceSentMessage.message;
    else if (cur.editedMessage?.message?.protocolMessage?.editedMessage) cur = cur.editedMessage.message.protocolMessage.editedMessage;
    else break;
  }
  return cur;
}

/**
 * Extract clean string text / caption from any WhatsApp message container.
 */
export function extractMessageText(message) {
  const inner = unpackMessage(message);
  return (
    inner?.conversation ||
    inner?.extendedTextMessage?.text ||
    inner?.imageMessage?.caption ||
    inner?.videoMessage?.caption ||
    inner?.documentMessage?.caption ||
    ''
  ).trim();
}

