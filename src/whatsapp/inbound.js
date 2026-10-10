import { downloadContentFromMessage } from 'plogme';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { toTelegramStaticSticker, toTelegramVideoSticker, toWhatsAppSticker, isAnimatedWebP, isWebPBuffer } from '../media/convert.js';
import { unpackMessage } from './session.js';
import { randomToken } from '../utils/hash.js';
import { RichMessageBuilder, rt, richButton, encodeCallback } from '../telegram/rich.js';
import { kvTable } from '../telegram/ui.js';
import { truncate } from '../utils/text.js';
import { logger } from '../core/logger.js';
import { sanitizeWhatsAppPackName } from './publisher.js';
import { extractTelegramPackName } from '../stickers/packNaming.js';

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * InboundHandler — handles WhatsApp DM commands:
 *   .ping, .menu, .convert (alias .cv), .tg, .s (alias .sticker)
 *
 * Exclusively active on 1-on-1 private chats (DM only).
 * Converts WhatsApp stickers (or sticker packs) into Telegram format,
 * delivers the sticker and a rich card with preview to the Telegram user,
 * and lets them add to an existing pack or create a new pack on Telegram.
 */
export class InboundHandler {
  constructor({ app, log } = {}) {
    this.app = app;
    this.log = log ?? logger().child({ module: 'wa-inbound' });
  }

  async handle({ session, message: m, command, text }) {
    const remoteJid = m?.key?.remoteJid;
    if (!remoteJid) return;
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter') || remoteJid.endsWith('@broadcast')) return;

    this.log.info({ sessionId: session?.sessionId, remoteJid, command }, 'inbound wa command');

    // WhatsApp presence indicator: show composing while processing command
    await session?.sock?.sendPresenceUpdate?.('composing', remoteJid).catch(() => {});

    try {
      switch (command) {
        case '.ping':
          return await this.#handlePing(session, m);
        case '.menu':
          return await this.#handleMenu(session, m);
        case '.prefix':
          return await this.#handlePrefix(session, m, text);
        case '.convert':
        case '.cv':
          return await this.#handleConvert(session, m);
        case '.tg':
          return await this.#handleTgToWa(session, m, text);
        case '.s':
        case '.sticker':
          return await this.#handleImageToWaSticker(session, m);
        default:
          return;
      }
    } catch (error) {
      this.log.error({ err: error, command, sessionId: session?.sessionId }, 'inbound command error');
      await this.#sendReply(session, remoteJid, `✕ An error occurred while processing ${command}: ${error.message}`).catch(() => {});
    } finally {
      await session?.sock?.sendPresenceUpdate?.('paused', remoteJid).catch(() => {});
    }
  }

  async #sendReply(session, remoteJid, text) {
    try {
      return await session.sendText(remoteJid, text);
    } catch (err) {
      this.log.warn({ err: err?.message, remoteJid, sessionJid: session?.jid }, 'sendText to remoteJid failed, trying session.jid fallback');
      if (session?.jid && session.jid !== remoteJid) {
        return await session.sendText(session.jid, text);
      } else {
        throw err;
      }
    }
  }

  async #sendOrEditStatus(session, remoteJid, currentMsgKey, text) {
    if (currentMsgKey) {
      try {
        await session.editText(remoteJid, currentMsgKey, text);
        return currentMsgKey;
      } catch (err) {
        this.log.debug({ err: err?.message }, 'editText failed, falling back to sendText');
      }
    }
    try {
      const res = await session.sendText(remoteJid, text);
      return res?.key || null;
    } catch (err) {
      if (session?.jid && session.jid !== remoteJid) {
        const fallback = await session.sendText(session.jid, text).catch(() => null);
        return fallback?.key || null;
      }
      return null;
    }
  }

  async #handlePing(session, m) {
    const remoteJid = m.key.remoteJid;
    const now = Date.now();
    const sentTime = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : now;
    const latency = Math.max(1, now - sentTime);

    const reply = `𓆩♡𓆪 *Pong!* 𓆩♡𓆪
> ⏱ Latency: ${latency}ms
> 📱 Session: ${session.name || 'Lancy'}
> ✨ Status: Online & Connected ♡`;

    await this.#sendReply(session, remoteJid, reply);
  }

  async #handleMenu(session, m) {
    const remoteJid = m.key.remoteJid;
    const p = session?.getPrefix?.() || '.';
    const menu = `╭──────────────────────────╮
│    ✦ LANCY WA HELPER ✦   │
╰──────────────────────────╯

🎀 *Commands (DM Only):*
• *${p}ping* — Check bot response & latency
• *${p}menu* — Display this helper menu
• *${p}prefix <symbol>* — Change command prefix (e.g. ${p}prefix !)
• *${p}convert* (or *${p}cv*) — Convert WhatsApp sticker to Telegram!
• *${p}tg <link>* — Convert Telegram sticker pack to WhatsApp!
• *${p}s* (or *${p}sticker*) — Turn photo/image into a WhatsApp sticker!

🌸 *How to Use:*
1. *WA → TG:* Reply to any sticker or pack with *${p}convert* or *${p}cv* to send to Telegram bot DM.
2. *TG → WA:* Send *${p}tg <link>* (e.g. ${p}tg https://t.me/addstickers/pack) to drop it into WhatsApp (splits >60 automatically).
3. *Photo → Sticker:* Reply to any image or send a photo with caption *${p}s* or *${p}sticker* to get a WhatsApp sticker
4. *Custom Prefix:* Send *${p}prefix !* or *${p}prefix #* to customize your command trigger ♡`;

    await this.#sendReply(session, remoteJid, menu);
  }

  async #handlePrefix(session, m, text) {
    const remoteJid = m.key.remoteJid;
    const currentPrefix = session?.getPrefix?.() || '.';
    const parts = String(text || '').trim().split(/\s+/);
    const newPrefix = parts[1];

    if (!newPrefix || newPrefix === '?' || newPrefix === 'help') {
      const reply = `𓆩♡𓆪 *COMMAND PREFIX* 𓆩♡𓆪
> 🌸 Current prefix: *${currentPrefix}*
> 🎀 To change prefix, send: *${currentPrefix}prefix <symbol>*
> ✨ Example: *${currentPrefix}prefix !* or *${currentPrefix}prefix #*
> 🔒 Commands strictly require your active prefix ♡`;
      return await this.#sendReply(session, remoteJid, reply);
    }

    if ([...newPrefix].length > 4) {
      return await this.#sendReply(session, remoteJid, `✕ Prefix must be 1 to 4 characters long (e.g. . ! # $ 😡) ♡`);
    }

    session.setPrefix(newPrefix);
    const reply = `𓆩♡𓆪 *PREFIX UPDATED* 𓆩♡𓆪
> ✨ New prefix is now: *${newPrefix}*
> 🎀 Try it now: *${newPrefix}menu* or *${newPrefix}ping*
> 🔒 Former prefix is disabled — only *${newPrefix}* commands will trigger ♡`;

    await this.#sendReply(session, remoteJid, reply);
  }

  async #handleConvert(session, m) {
    const remoteJid = m.key.remoteJid;
    const direct = unpackMessage(m.message);
    const quoted = unpackMessage(direct?.extendedTextMessage?.contextInfo?.quotedMessage);

    const stickerMsg = quoted?.stickerMessage ?? direct?.stickerMessage;
    const stickerPackMsg = quoted?.stickerPackMessage ?? direct?.stickerPackMessage;
    const imageMsg = quoted?.imageMessage ?? direct?.imageMessage;
    const videoMsg = quoted?.videoMessage ?? direct?.videoMessage;
    const docMsg = quoted?.documentMessage ?? direct?.documentMessage;
    const isDocVideo = docMsg?.mimetype?.startsWith('video/') || docMsg?.mimetype === 'image/gif';

    if (!stickerMsg && !stickerPackMsg && !imageMsg && !videoMsg && !isDocVideo) {
      return await this.#sendReply(
        session,
        remoteJid,
        '𓆩♡𓆪 *WA → TELEGRAM* 𓆩♡𓆪\n> ♡ Please reply to a sticker or sticker pack, image, video, or GIF with *.convert* (or *.cv*) to send it to Telegram!'
      );
    }

    // Resolve destination Telegram user ID for this session
    const targetUserId = this.#resolveUserId(session);
    if (!targetUserId) {
      return await this.#sendReply(session, remoteJid, '✕ No owner Telegram account is linked to this session.');
    }

    if (stickerPackMsg) {
      return await this.#convertStickerPack(session, remoteJid, stickerPackMsg, targetUserId);
    }

    if (stickerMsg) {
      return await this.#convertSingleSticker(session, remoteJid, stickerMsg, targetUserId);
    }

    if (videoMsg || isDocVideo) {
      return await this.#convertVideoToSticker(session, remoteJid, videoMsg || docMsg, targetUserId);
    }

    if (imageMsg) {
      return await this.#convertImageToSticker(session, remoteJid, imageMsg, targetUserId);
    }
  }

  async #convertVideoToSticker(session, remoteJid, videoMsg, targetUserId) {
    await this.#sendReply(
      session,
      remoteJid,
      '𓆩♡𓆪 *WA → TELEGRAM VIDEO STICKER* 𓆩♡𓆪\n> ⏳ Video/GIF received! Converting to Telegram video sticker (WebM VP9)…\n> ⏱ Compressing to ≤256 KB • check your Telegram bot DM ♡'
    ).catch(() => {});

    const msgType = videoMsg.mimetype ? (videoMsg.mimetype.startsWith('video/') ? 'video' : 'document') : 'video';
    const stream = await downloadContentFromMessage(videoMsg, msgType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const rawBuffer = Buffer.concat(chunks);

    const converted = await toTelegramVideoSticker(rawBuffer, {
      configuredFfmpeg: this.app.settings?.get('media.ffmpegPath') ?? ''
    });
    const tgBuffer = converted.buffer;

    let previewImage = null;
    try {
      previewImage = await sharp(rawBuffer, { failOn: 'none', page: 0 })
        .resize(512, 512, { fit: 'inside' })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      previewImage = null;
    }

    const token = randomToken(10);
    const itemData = [{
      bufferBase64: tgBuffer.toString('base64'),
      stickerType: 'video',
      isAnimated: true,
      emojis: ['🤍']
    }];

    this.#saveImport({
      id: token,
      userId: targetUserId,
      sessionId: session.sessionId,
      stickerType: 'video',
      count: 1,
      dataJson: JSON.stringify(itemData)
    });

    const b = new RichMessageBuilder();
    b.heading('✦ WA → TG VIDEO STICKER IMPORT ✦', 2);
    if (previewImage) {
      b.photo({ type: 'photo', media: 'attach://preview' });
    }
    b.divider();
    b.table(kvTable([
      ['Type', 'Animated Video (WebM VP9)'],
      ['Size', `${(tgBuffer.length / 1024).toFixed(1)} KB`],
      ['Duration', converted.duration ? `${converted.duration.toFixed(1)}s` : '≤3s'],
      ['Dimensions', '512 × 512'],
      ['WhatsApp Source', `${session.name || 'Session'} (${session.phone ?? 'DM'})`],
      ['Status', 'Converted & Ready ✓']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('choose where to save it in Telegram ♡'));
    b.buttons([
      richButton.callback('➕ Add to Existing Pack', encodeCallback('stickers', 'waAddChoose', token), { style: 'primary' }),
      richButton.callback('✨ Create New Pack', encodeCallback('stickers', 'waCreateNew', token), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('✕ Dismiss', encodeCallback('stickers', 'waDismiss', token), { style: 'danger' })
    ]);
    b.validate();

    const files = previewImage ? {
      preview: { buffer: previewImage, filename: 'preview.jpg', contentType: 'image/jpeg' }
    } : null;

    await this.app.telegram.api.sendRichMessage(targetUserId, b.toJSON(), {}, files).catch((err) => {
      this.log.error({ err }, 'failed to send rich message to tg');
    });

    await this.#sendReply(session, remoteJid, '✓ Sent to Telegram! Check your bot DM to save it ♡').catch(() => {});
  }

  async #convertSingleSticker(session, remoteJid, stickerMsg, targetUserId) {
    await this.#sendReply(
      session,
      remoteJid,
      '𓆩♡𓆪 *WA → TELEGRAM* 𓆩♡𓆪\n> ⏳ Sticker received! Converting and delivering to your Telegram bot DM…\n> ⏱ Please check your Telegram bot to save ♡'
    ).catch(() => {});

    const stream = await downloadContentFromMessage(stickerMsg, 'sticker');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const rawBuffer = Buffer.concat(chunks);

    const isAnimated = Boolean(stickerMsg.isAnimated || isAnimatedWebP(rawBuffer));
    let tgBuffer;
    let stickerType = 'static';

    if (isAnimated) {
      stickerType = 'video';
      try {
        const converted = await toTelegramVideoSticker(rawBuffer, {
          configuredFfmpeg: this.app.settings?.get('media.ffmpegPath') ?? ''
        });
        tgBuffer = converted.buffer;
      } catch (err) {
        this.log.warn({ err }, 'video sticker convert failed, falling back to static');
        const converted = await toTelegramStaticSticker(rawBuffer);
        tgBuffer = converted.buffer;
        stickerType = 'static';
      }
    } else {
      const converted = await toTelegramStaticSticker(rawBuffer);
      tgBuffer = converted.buffer;
    }

    // Generate high quality preview image (512x512 JPEG)
    let previewImage;
    try {
      previewImage = await sharp(rawBuffer, { failOn: 'none', page: 0 })
        .resize(512, 512, { fit: 'inside' })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      previewImage = tgBuffer;
    }

    const token = randomToken(10);
    const itemData = [{
      bufferBase64: tgBuffer.toString('base64'),
      stickerType,
      isAnimated,
      emojis: ['🤍']
    }];

    this.#saveImport({
      id: token,
      userId: targetUserId,
      sessionId: session.sessionId,
      stickerType,
      count: 1,
      dataJson: JSON.stringify(itemData)
    });

    // Deliver ONE single Rich Message with embedded photo preview and action buttons
    const b = new RichMessageBuilder();
    b.heading('✦ WA → TG STICKER IMPORT ✦', 2);
    b.photo({ type: 'photo', media: 'attach://preview' });
    b.divider();
    b.table(kvTable([
      ['Type', stickerType === 'video' ? 'Animated (WebM)' : 'Static (WebP)'],
      ['Size', `${(tgBuffer.length / 1024).toFixed(1)} KB`],
      ['Dimensions', '512 × 512'],
      ['WhatsApp Source', `${session.name || 'Session'} (${session.phone ?? 'DM'})`],
      ['Status', 'Converted & Ready ✓']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('choose where to save it in Telegram ♡'));
    b.buttons([
      richButton.callback('➕ Add to Existing Pack', encodeCallback('stickers', 'waAddChoose', token), { style: 'primary' }),
      richButton.callback('✨ Create New Pack', encodeCallback('stickers', 'waCreateNew', token), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('✕ Dismiss', encodeCallback('stickers', 'waDismiss', token), { style: 'danger' })
    ]);
    b.validate();

    await this.app.telegram.api.sendRichMessage(targetUserId, b.toJSON(), {}, {
      preview: { buffer: previewImage, filename: 'preview.jpg', contentType: 'image/jpeg' }
    }).catch((err) => {
      this.log.error({ err }, 'failed to send rich message to tg');
    });

    await this.#sendReply(session, remoteJid, '✓ Sent to Telegram! Check your bot DM to save it ♡').catch(() => {});
  }

  async #convertStickerPack(session, remoteJid, stickerPackMsg, targetUserId) {
    let zipBuffer = Buffer.alloc(0);
    try {
      const stream = await downloadContentFromMessage(stickerPackMsg, 'sticker-pack');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      zipBuffer = Buffer.concat(chunks);
    } catch (dlErr) {
      this.log.warn({ err: dlErr?.message }, 'downloadContentFromMessage for sticker pack failed');
    }

    if (!zipBuffer || zipBuffer.length < 22) {
      return await this.#sendReply(
        session,
        remoteJid,
        '✕ Could not download that sticker pack from WhatsApp (buffer empty or link expired). Please try sending or forwarding the pack again ♡'
      );
    }

    let unzipped;
    try {
      unzipped = unzipSync(zipBuffer);
    } catch (unzipErr) {
      this.log.warn({ err: unzipErr?.message, zipLength: zipBuffer.length }, 'unzipSync failed for sticker pack');
      return await this.#sendReply(
        session,
        remoteJid,
        '✕ Could not unpack stickers from that sticker pack zip file. Please try sending it again ♡'
      );
    }

    const webpFiles = Object.entries(unzipped).filter(([name]) => name.endsWith('.webp') && !name.includes('tray'));

    if (!webpFiles.length) {
      return await this.#sendReply(session, remoteJid, '✕ Could not extract any stickers from that pack.');
    }

    const total = webpFiles.length;
    const estSec = Math.max(2, Math.ceil(total * 0.25));
    const hasVideo = webpFiles.some(([, rawBytes]) => isAnimatedWebP(Buffer.from(rawBytes)));

    let statusKey = null;
    if (hasVideo) {
      statusKey = await this.#sendOrEditStatus(
        session,
        remoteJid,
        null,
        `𓆩♡𓆪 *WA → TELEGRAM* 𓆩♡𓆪\n> 📹 Video/Animated stickers detected!\n> ⏳ Received pack with ${total} stickers! Fast WebM VP9 conversion in progress…\n> ⏱ Please wait a moment, bot is processing & online ♡`
      );
    } else {
      statusKey = await this.#sendOrEditStatus(
        session,
        remoteJid,
        null,
        `𓆩♡𓆪 *WA → TELEGRAM* 𓆩♡𓆪\n> ⏳ Received pack with ${total} stickers!\n> ⏱ Fast HD conversion in progress (~${estSec}s remaining) ♡`
      );
    }

    const items = [];
    let firstPreview = null;
    let stickerType = 'static';
    let previewContentType = 'image/jpeg';
    let previewFilename = 'preview.jpg';

    for (let i = 0; i < webpFiles.length; i++) {
      const [, rawBytes] = webpFiles[i];
      const buffer = Buffer.from(rawBytes);
      const isAnimated = isAnimatedWebP(buffer);
      let tgBuf;

      if (isAnimated) {
        stickerType = 'video';
        try {
          const res = await toTelegramVideoSticker(buffer, {
            configuredFfmpeg: this.app.settings?.get('media.ffmpegPath') ?? ''
          });
          tgBuf = res.buffer;
        } catch {
          const res = await toTelegramStaticSticker(buffer);
          tgBuf = res.buffer;
        }
      } else {
        const res = await toTelegramStaticSticker(buffer);
        tgBuf = res.buffer;
      }

      if (i === 0) {
        try {
          firstPreview = await sharp(buffer, { failOn: 'none', page: 0 })
            .resize(512, 512, { fit: 'inside' })
            .jpeg({ quality: 85 })
            .toBuffer();
          previewContentType = 'image/jpeg';
          previewFilename = 'preview.jpg';
        } catch {
          firstPreview = null;
        }
      }

      items.push({
        bufferBase64: tgBuf.toString('base64'),
        stickerType,
        isAnimated,
        emojis: ['🤍']
      });

      // Periodic progress heads up for larger packs via in-place message edit
      if (total >= 15 && (i + 1) % 10 === 0 && (i + 1) < total && statusKey) {
        const pct = Math.round(((i + 1) / total) * 100);
        statusKey = await this.#sendOrEditStatus(
          session,
          remoteJid,
          statusKey,
          `𓆩♡𓆪 *CONVERTING PACK* 𓆩♡𓆪\n> ⏳ Converted ${i + 1}/${total} stickers (${pct}% done)…\n> ⏱ Bot is actively processing & online ♡`
        );
      }
    }

    const token = randomToken(10);
    const packTitle = stickerPackMsg.name ?? 'WhatsApp Sticker Pack';

    this.#saveImport({
      id: token,
      userId: targetUserId,
      sessionId: session.sessionId,
      stickerType,
      count: items.length,
      dataJson: JSON.stringify(items)
    });

    // Deliver ONE single Rich Message with pack summary, preview media, and action buttons
    const b = new RichMessageBuilder();
    b.heading('✦ WA → TG PACK IMPORT ✦', 2);
    if (firstPreview) {
      b.photo({ type: 'photo', media: 'attach://preview' });
    }
    b.divider();
    b.table(kvTable([
      ['Pack Name', truncate(packTitle, 24)],
      ['Total Stickers', String(items.length)],
      ['Type', stickerType === 'video' ? 'Animated / Video (WebM)' : 'Static (WebP)'],
      ['WhatsApp Source', `${session.name || 'Session'} (${session.phone ?? 'DM'})`],
      ['Status', 'Pack converted & ready ✓']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic(`choose where to save this ${items.length}-sticker pack in Telegram ♡`));
    b.buttons([
      richButton.callback(`➕ Add ${items.length} to Existing Pack`, encodeCallback('stickers', 'waAddChoose', token), { style: 'primary' }),
      richButton.callback(`✨ Create New Pack (${items.length})`, encodeCallback('stickers', 'waCreateNew', token), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('✕ Dismiss', encodeCallback('stickers', 'waDismiss', token), { style: 'danger' })
    ]);
    b.validate();

    const files = firstPreview ? {
      preview: { buffer: firstPreview, filename: previewFilename, contentType: previewContentType }
    } : null;

    const sent = await this.app.telegram.api.sendRichMessage(targetUserId, b.toJSON(), {}, files).catch((err) => {
      this.log.error({ err }, 'failed to send pack rich message to tg');
    });
    if (sent?.message_id) {
      this.app.telegram?.markMediaDeliveryMessage?.(sent.message_id);
    }

    await this.#sendOrEditStatus(
      session,
      remoteJid,
      statusKey,
      `𓆩♡𓆪 *WA → TELEGRAM* 𓆩♡𓆪\n> ✓ Pack of ${items.length} stickers sent to Telegram!\n> 🌸 Open your bot DM to save to an existing pack or create a new pack ♡`
    );
  }

  async #convertImageToSticker(session, remoteJid, imageMsg, targetUserId) {
    await this.#sendReply(
      session,
      remoteJid,
      '𓆩♡𓆪 *WA → TELEGRAM* 𓆩♡𓆪\n> ⏳ Image received! Converting to Telegram sticker…\n> ⏱ WebP 512×512 HD conversion in progress ♡'
    ).catch(() => {});

    const stream = await downloadContentFromMessage(imageMsg, 'image');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const rawBuffer = Buffer.concat(chunks);

    const converted = await toTelegramStaticSticker(rawBuffer);
    const tgBuffer = converted.buffer;

    let previewImage;
    try {
      previewImage = await sharp(rawBuffer, { failOn: 'none' })
        .resize(512, 512, { fit: 'inside' })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      previewImage = tgBuffer;
    }

    const token = randomToken(10);
    const itemData = [{
      bufferBase64: tgBuffer.toString('base64'),
      stickerType: 'static',
      isAnimated: false,
      emojis: ['🤍']
    }];

    this.#saveImport({
      id: token,
      userId: targetUserId,
      sessionId: session.sessionId,
      stickerType: 'static',
      count: 1,
      dataJson: JSON.stringify(itemData)
    });

    const b = new RichMessageBuilder();
    b.heading('✦ WA → TG STICKER IMPORT ✦', 2);
    b.photo({ type: 'photo', media: 'attach://preview' });
    b.divider();
    b.table(kvTable([
      ['Type', 'Static (WebP)'],
      ['Size', `${(tgBuffer.length / 1024).toFixed(1)} KB`],
      ['Dimensions', '512 × 512'],
      ['WhatsApp Source', `${session.name || 'Session'} (${session.phone ?? 'DM'})`],
      ['Status', 'Converted & Ready ✓']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('choose where to save it in Telegram ♡'));
    b.buttons([
      richButton.callback('➕ Add to Existing Pack', encodeCallback('stickers', 'waAddChoose', token), { style: 'primary' }),
      richButton.callback('✨ Create New Pack', encodeCallback('stickers', 'waCreateNew', token), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('✕ Dismiss', encodeCallback('stickers', 'waDismiss', token), { style: 'danger' })
    ]);
    b.validate();

    await this.app.telegram.api.sendRichMessage(targetUserId, b.toJSON(), {}, {
      preview: { buffer: previewImage, filename: 'preview.jpg', contentType: 'image/jpeg' }
    }).catch(() => {});

    await this.#sendReply(
      session,
      remoteJid,
      '𓆩♡𓆪 *WA → TELEGRAM* 𓆩♡𓆪\n> ✓ Sticker delivered to your Telegram bot DM ♡'
    ).catch(() => {});
  }

  async #handleTgToWa(session, m, text) {
    const remoteJid = m.key.remoteJid;
    let input = (text ?? '').replace(/^\.tg\s*/i, '').trim();
    if (!input) {
      const direct = unpackMessage(m.message);
      const quoted = unpackMessage(direct?.extendedTextMessage?.contextInfo?.quotedMessage);
      input = (quoted?.conversation || quoted?.extendedTextMessage?.text || '').trim();
    }

    const shortName = extractTelegramPackName(input);
    if (!shortName) {
      return await this.#sendReply(
        session,
        remoteJid,
        '𓆩♡𓆪 *TELEGRAM → WHATSAPP* 𓆩♡𓆪\n> ♡ Please send a Telegram sticker pack link or name!\n> 🎀 *Usage:* `.tg https://t.me/addstickers/pack_name`'
      );
    }

    let set;
    try {
      set = await this.app.telegram.api.getStickerSet(shortName);
    } catch (err) {
      return await this.#sendReply(
        session,
        remoteJid,
        `𓆩♡𓆪 *TELEGRAM → WHATSAPP* 𓆩♡𓆪\n> ✕ Could not find Telegram sticker set "${shortName}": ${err.message}`
      );
    }

    if (!set || !Array.isArray(set.stickers) || set.stickers.length === 0) {
      return await this.#sendReply(
        session,
        remoteJid,
        `𓆩♡𓆪 *TELEGRAM → WHATSAPP* 𓆩♡𓆪\n> ✕ Telegram pack "${shortName}" is empty.`
      );
    }

    const total = set.stickers.length;
    const title = set.title || shortName;
    const hasVideo = set.stickers.some((s) => s.is_video || s.type === 'video');
    const hasAnimated = set.stickers.some((s) => s.is_animated || s.type === 'animated');

    let statusKey = null;
    if (hasVideo || hasAnimated) {
      statusKey = await this.#sendOrEditStatus(
        session,
        remoteJid,
        null,
        `𓆩♡𓆪 *TELEGRAM → WHATSAPP* 𓆩♡𓆪\n> 📹 Video/Animated stickers detected!\n> ⏳ Converting ${total} stickers with fast VP9/WebM engine…\n> ⏱ Please wait a moment, bot is processing & online ♡`
      );
    } else {
      statusKey = await this.#sendOrEditStatus(
        session,
        remoteJid,
        null,
        `𓆩♡𓆪 *TELEGRAM → WHATSAPP* 𓆩♡𓆪\n> ⏳ Downloading & converting ${total} sticker${total === 1 ? '' : 's'} from "${title}"…\n> ⏱ 512×512 HD WebP conversion in progress ♡`
      );
    }

    let converted = [];
    if (this.app.publisher?.convertTelegramPack) {
      const packData = await this.app.publisher.convertTelegramPack(shortName, {
        telegramApi: this.app.telegram.api,
        onProgress: async ({ converted: processedCount, total: totalStickers }) => {
          if (statusKey && (processedCount % 5 === 0 || processedCount === totalStickers)) {
            const pct = Math.round((processedCount / totalStickers) * 100);
            statusKey = await this.#sendOrEditStatus(
              session,
              remoteJid,
              statusKey,
              `𓆩♡𓆪 *CONVERTING STICKERS* 𓆩♡𓆪\n> ⏳ Converted ${processedCount}/${totalStickers} stickers (${pct}% done)…\n> ⏱ Bot is actively processing & online ♡`
            );
          }
        }
      });
      converted = packData?.stickers ?? [];
    } else {
      const ffmpegPath = this.app.settings?.get('media.ffmpegPath') ?? '';
      const concurrency = 4;

      for (let i = 0; i < set.stickers.length; i += concurrency) {
        const chunk = set.stickers.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map(async (st) => {
          try {
            let fileId = st.file_id;
            // For animated .tgs (Lottie), download static WebP thumbnail so it converts cleanly
            if (st.is_animated && (st.thumbnail || st.thumb)) {
              fileId = (st.thumbnail || st.thumb).file_id;
            }
            const file = await this.app.telegram.api.getFile(fileId);
            const rawBuffer = await this.app.telegram.api.downloadFile(file.file_path);
            const webpBuffer = await toWhatsAppSticker(rawBuffer, { configuredFfmpeg: ffmpegPath });
            if (webpBuffer && isWebPBuffer(webpBuffer)) {
              return {
                buffer: webpBuffer,
                emoji: st.emoji ? [st.emoji] : ['🤍']
              };
            }
          } catch (err) {
            this.log.warn({ err: err?.message, fileId: st.file_id }, 'failed to convert sticker from TG pack');
          }
          return null;
        }));

        for (const res of chunkResults) {
          if (res) converted.push(res);
        }

        const processedCount = Math.min(i + concurrency, total);
        if (statusKey && (processedCount % 5 === 0 || processedCount === total)) {
          const pct = Math.round((processedCount / total) * 100);
          statusKey = await this.#sendOrEditStatus(
            session,
            remoteJid,
            statusKey,
            `𓆩♡𓆪 *CONVERTING STICKERS* 𓆩♡𓆪\n> ⏳ Converted ${processedCount}/${total} stickers (${pct}% done)…\n> ⏱ Bot is actively processing & online ♡`
          );
        }
      }
    }

    if (converted.length === 0) {
      return await this.#sendOrEditStatus(session, remoteJid, statusKey, '✕ Failed to convert stickers from that Telegram pack.');
    }

    const cleanTitle = sanitizeWhatsAppPackName(title);
    const userId = this.#resolveUserId(session);
    const publisherName = this.app.settings?.getForUser?.(userId, 'stickers.creatorName') ?? 'Lancy';

    // WhatsApp physical limits: 30 for animated/video stickers (to keep pack ZIP size under MMS limits), 60 for static
    const isAnimatedPack = hasVideo || hasAnimated || converted.some((s) => isAnimatedWebP(s.buffer));
    const packLimit = isAnimatedPack ? 30 : 60;

    const parts = [];
    for (let i = 0; i < converted.length; i += packLimit) {
      parts.push(converted.slice(i, i + packLimit));
    }

    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const partStickers = parts[pIdx];
      const partName = parts.length === 1 ? cleanTitle : `${cleanTitle} - Part 0${pIdx + 1}`;

      let partCover = null;
      try {
        partCover = await sharp(partStickers[0].buffer, { failOn: 'none', page: 0 })
          .resize(96, 96, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .png()
          .toBuffer();
      } catch {
        partCover = await sharp({
          create: { width: 96, height: 96, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
        }).png().toBuffer();
      }

      await session.sendStickerPack(remoteJid, {
        name: partName,
        publisher: publisherName,
        description: `${partName} • ${partStickers.length} stickers`,
        cover: partCover,
        stickers: partStickers
      });

      if (pIdx < parts.length - 1) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    if (parts.length === 1) {
      await this.#sendOrEditStatus(
        session,
        remoteJid,
        statusKey,
        `𓆩♡𓆪 *STICKER PACK DELIVERED* 𓆩♡𓆪\n> ✓ Dropped sticker pack "${cleanTitle}" (${converted.length} stickers) to WhatsApp!\n> 🌸 Tap pack above to view & add to your stickers ♡`
      );
    } else {
      await this.#sendOrEditStatus(
        session,
        remoteJid,
        statusKey,
        `𓆩♡𓆪 *STICKER PACKS DELIVERED* 𓆩♡𓆪\n> ✓ Dropped ${parts.length} packs (${converted.length} total stickers) to WhatsApp!\n> 🌸 Tap packs above to view & add to your stickers ♡`
      );
    }
  }

  async #handleImageToWaSticker(session, m) {
    const remoteJid = m.key.remoteJid;
    const direct = unpackMessage(m.message);
    const quoted = unpackMessage(direct?.extendedTextMessage?.contextInfo?.quotedMessage);

    const imageMsg = quoted?.imageMessage ?? direct?.imageMessage;
    const stickerMsg = quoted?.stickerMessage ?? direct?.stickerMessage;
    const videoMsg = quoted?.videoMessage ?? direct?.videoMessage;
    const docMsg = quoted?.documentMessage ?? direct?.documentMessage;
    const isDocVideo = docMsg?.mimetype?.startsWith('video/') || docMsg?.mimetype === 'image/gif';

    if (!imageMsg && !stickerMsg && !videoMsg && !isDocVideo) {
      return await this.#sendReply(
        session,
        remoteJid,
        '𓆩♡𓆪 *MEDIA → STICKER* 𓆩♡𓆪\n> ♡ Please reply to an image, video, GIF, or sticker with *.s* (or *.sticker*) to turn it into a WhatsApp sticker!'
      );
    }

    const isVideo = Boolean(videoMsg || isDocVideo);
    if (isVideo) {
      await this.#sendReply(
        session,
        remoteJid,
        '𓆩♡𓆪 *VIDEO → STICKER* 𓆩♡𓆪\n> ⏳ Video/GIF received! Converting to animated WhatsApp sticker…\n> ⏱ Creating 512×512 animated WebP (≤500 KB) ♡'
      ).catch(() => {});
    }

    const mediaMsg = videoMsg || (isDocVideo ? docMsg : (imageMsg || stickerMsg));
    const msgType = videoMsg ? 'video' : (isDocVideo ? 'document' : (imageMsg ? 'image' : 'sticker'));
    const stream = await downloadContentFromMessage(mediaMsg, msgType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const rawBuffer = Buffer.concat(chunks);

    const ffmpegPath = this.app.settings?.get('media.ffmpegPath') ?? '';
    const webpBuffer = await toWhatsAppSticker(rawBuffer, { configuredFfmpeg: ffmpegPath });

    await session.sendSticker(remoteJid, webpBuffer);
  }

  #resolveUserId(session) {
    if (session?.userId) return Number(session.userId);
    try {
      const row = this.app.db.get('SELECT user_id FROM wa_sessions WHERE session_id = ?', session?.sessionId);
      if (row?.user_id) return Number(row.user_id);
    } catch {}
    const ownerId = this.app.env?.OWNER_IDS?.split?.(',')?.[0]?.trim();
    if (ownerId && !isNaN(Number(ownerId))) return Number(ownerId);
    return null;
  }

  #saveImport({ id, userId, sessionId, stickerType, count, dataJson }) {
    this.app.db.run(
      `INSERT INTO wa_sticker_imports (id, user_id, session_id, sticker_type, count, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      id, userId, sessionId, stickerType, count, dataJson
    );
  }

  getImport(id) {
    const row = this.app.db.get('SELECT * FROM wa_sticker_imports WHERE id = ?', id);
    if (!row) return null;
    return {
      ...row,
      items: JSON.parse(row.data_json ?? '[]')
    };
  }

  deleteImport(id) {
    this.app.db.run('DELETE FROM wa_sticker_imports WHERE id = ?', id);
  }
}
