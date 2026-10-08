import { logger } from '../core/logger.js';
import { sleep } from '../utils/time.js';

/**
 * Minimal, precise Telegram Bot API client (Bot API 10.3).
 *
 * We deliberately talk to the HTTP API directly instead of relying on a
 * wrapper library: Rich Messages (sendRichMessage / editMessageText with
 * rich_message) are brand new in Bot API 10.1–10.3 and library support is
 * uneven. This client supports JSON and multipart uploads natively.
 */
export class TelegramAPI {
  constructor(token, { baseUrl = 'https://api.telegram.org', timeoutMs = 60000, log } = {}) {
    if (!token) throw new Error('TelegramAPI: BOT_TOKEN is required');
    this.token = token;
    this.baseUrl = `${baseUrl}/bot${token}`;
    this.timeoutMs = timeoutMs;
    this.log = log ?? logger().child({ module: 'telegram-api' });
    this.me = null;
  }

  async call(method, params = {}, { files = null, timeoutMs = this.timeoutMs } = {}) {
    const url = `${this.baseUrl}/${method}`;
    let body;
    let headers = {};
    if (files && Object.keys(files).length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      for (const [field, file] of Object.entries(files)) {
        const { buffer, filename = field, contentType = 'application/octet-stream' } = file;
        form.append(field, new Blob([buffer], { type: contentType }), filename);
      }
      body = form;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(params);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      const err = new Error(`Telegram request failed (${method}): ${error.message}`);
      err.code = 'NETWORK';
      err.retryable = true;
      throw err;
    }
    clearTimeout(timer);

    const data = await response.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.description ?? response.statusText}`);
      err.code = 'TELEGRAM';
      err.description = data.description;
      err.errorCode = data.error_code;
      err.parameters = data.parameters;
      err.retryable = data.error_code === 429 || (data.error_code >= 500 && data.error_code < 600);
      // Flood wait: back off once, transparently.
      if (data.error_code === 429 && data.parameters?.retry_after) {
        const wait = Math.min(30, Number(data.parameters.retry_after) + 1);
        this.log.warn({ method, wait }, 'flood wait — backing off');
        await sleep(wait * 1000);
        return this.call(method, params, { files, timeoutMs });
      }
      throw err;
    }
    return data.result;
  }

  // ── Core ──────────────────────────────────────────────────────────────
  getMe() {
    return this.call('getMe').then((me) => {
      this.me = me;
      return me;
    });
  }

  get botUsername() {
    return this.me?.username ?? '';
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra });
  }

  /** Bot API 10.1+: send a Rich Message. rich_message = InputRichMessage */
  sendRichMessage(chatId, richMessage, extra = {}, files = null) {
    return this.call('sendRichMessage', { chat_id: chatId, rich_message: richMessage, ...extra }, { files });
  }

  /** Edit a message's rich content (Bot API 10.1+ rich_message param). */
  editMessageRich(chatId, messageId, richMessage, extra = {}, files = null) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      rich_message: richMessage,
      ...extra
    }, { files });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  sendPhoto(chatId, photo, extra = {}, files = null) {
    const params = { chat_id: chatId, ...extra };
    if (files?.photo) {
      return this.call('sendPhoto', params, { files });
    }
    params.photo = photo;
    return this.call('sendPhoto', params);
  }

  sendDocument(chatId, document, extra = {}, files = null) {
    const params = { chat_id: chatId, ...extra };
    if (files?.document) {
      return this.call('sendDocument', params, { files });
    }
    params.document = document;
    return this.call('sendDocument', params);
  }

  sendSticker(chatId, sticker, extra = {}) {
    return this.call('sendSticker', { chat_id: chatId, sticker, ...extra });
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }

  answerCallbackQuery(id, { text, showAlert = false, url, cacheTime = 0 } = {}) {
    return this.call('answerCallbackQuery', {
      callback_query_id: id, text, show_alert: showAlert, url, cache_time: cacheTime
    }).catch(() => {});
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);
  }

  pinChatMessage(chatId, messageId, { disableNotification = true } = {}) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: disableNotification }).catch(() => null);
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  async downloadFile(filePath) {
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  setMyCommands(commands, extra = {}) {
    return this.call('setMyCommands', { commands, ...extra });
  }

  // ── Stickers ──────────────────────────────────────────────────────────
  getStickerSet(name) {
    return this.call('getStickerSet', { name });
  }

  /**
   * createNewStickerSet — current Bot API: `stickers` is a list of 1..N
   * InputSticker (initial limit is lower than the total set limit — we keep
   * it configurable and default to 1; the rest go through addStickerToSet).
   */
  createNewStickerSet({ userId, name, title, stickers, stickerType = 'regular', needsRepainting }) {
    const params = {
      user_id: userId,
      name,
      title,
      stickers,
      sticker_type: stickerType === 'emoji' ? 'custom_emoji' : stickerType
    };
    if (needsRepainting !== undefined) params.needs_repainting = needsRepainting;
    const files = {};
    const cleanStickers = stickers.map((sticker, index) => {
      const out = { ...sticker };
      if (sticker.sticker?.buffer) {
        const field = `sticker_${index}`;
        files[field] = { buffer: sticker.sticker.buffer, filename: sticker.sticker.filename ?? `${field}.webp` };
        out.sticker = `attach://${field}`;
      }
      return out;
    });
    params.stickers = cleanStickers;
    return this.call('createNewStickerSet', params, { files: Object.keys(files).length ? files : null });
  }

  addStickerToSet({ userId, name, sticker }) {
    const params = { user_id: userId, name, sticker };
    const files = {};
    if (sticker.sticker?.buffer) {
      files.sticker_file = { buffer: sticker.sticker.buffer, filename: sticker.sticker.filename ?? 'sticker.webp' };
      params.sticker = { ...sticker, sticker: 'attach://sticker_file' };
    }
    return this.call('addStickerToSet', params, { files: Object.keys(files).length ? files : null });
  }

  setStickerSetThumbnail({ name, userId, thumbnail }) {
    const params = { name, user_id: userId };
    const files = {};
    if (thumbnail?.buffer) {
      files.thumbnail = { buffer: thumbnail.buffer, filename: thumbnail.filename ?? 'thumb.webp' };
      params.thumbnail = 'attach://thumbnail';
    } else if (thumbnail) {
      params.thumbnail = thumbnail;
    }
    return this.call('setStickerSetThumbnail', params, { files: Object.keys(files).length ? files : null });
  }

  deleteStickerSet(name) {
    return this.call('deleteStickerSet', { name });
  }

  // ── Polling ───────────────────────────────────────────────────────────
  async poll({ offset, timeout = 30, signal } = {}) {
    const params = { offset, timeout, allowed_updates: ['message', 'callback_query', 'edited_message'] };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.call('getUpdates', params, { timeoutMs: (timeout + 10) * 1000 });
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) return [];
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
