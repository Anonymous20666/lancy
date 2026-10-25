import { logger } from '../core/logger.js';
import { sleep } from '../utils/time.js';
import { RichMessageBuilder } from './rich.js';

/**
 * Minimal, precise Telegram Bot API client (Bot API 10.3).
 *
 * We deliberately talk to the HTTP API directly instead of relying on a
 * wrapper library: Rich Messages (sendRichMessage / editMessageText with
 * rich_message) are brand new in Bot API 10.1–10.3 and library support is
 * uneven. This client supports JSON and multipart uploads natively.
 */
function sanitizeInlineResults(results) {
  if (!Array.isArray(results)) return results;
  return results.map(item => {
    if (!item || typeof item !== 'object') return item;
    const sanitized = { ...item };
    if (typeof sanitized.title === 'string') {
      sanitized.title = [...sanitized.title.toWellFormed()].slice(0, 64).join('').trim().toWellFormed();
    }
    if (typeof sanitized.description === 'string') {
      sanitized.description = [...sanitized.description.toWellFormed()].slice(0, 100).join('').trim().toWellFormed();
    }
    if (typeof sanitized.caption === 'string') {
      sanitized.caption = [...sanitized.caption.toWellFormed()].slice(0, 1024).join('').toWellFormed();
    }
    if (sanitized.reply_markup?.inline_keyboard) {
      sanitized.reply_markup = {
        ...sanitized.reply_markup,
        inline_keyboard: sanitized.reply_markup.inline_keyboard.map(row =>
          Array.isArray(row) ? row.map(btn => {
            if (!btn || typeof btn !== 'object') return btn;
            const b = { ...btn };
            if (typeof b.text === 'string') {
              b.text = [...b.text.toWellFormed()].slice(0, 64).join('').trim().toWellFormed();
            }
            if (typeof b.switch_inline_query_current_chat === 'string') {
              b.switch_inline_query_current_chat = [...b.switch_inline_query_current_chat.toWellFormed()].slice(0, 64).join('').toWellFormed();
            }
            if (typeof b.switch_inline_query === 'string') {
              b.switch_inline_query = [...b.switch_inline_query.toWellFormed()].slice(0, 64).join('').toWellFormed();
            }
            return b;
          }) : row
        )
      };
    }
    return sanitized;
  });
}

export class TelegramAPI {
  /**
   * baseUrl defaults to TELEGRAM_API_BASE_URL so a self-hosted Bot API server
   * (telegram-bot-api --local, 2000 MB uploads) is used by the main bot and clones.
   */
  constructor(token, { baseUrl = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org', timeoutMs = 60000, log } = {}) {
    if (!token) throw new Error('TelegramAPI: BOT_TOKEN is required');
    this.token = token;
    this.apiRoot = String(baseUrl).replace(/\/+$/, '');
    this.isLocalServer = this.apiRoot !== 'https://api.telegram.org';
    this.baseUrl = `${this.apiRoot}/bot${token}`;
    this.timeoutMs = timeoutMs;
    this.log = log ?? logger().child({ module: 'telegram-api' });
    this.me = null;
  }

  async call(method, params = {}, { files = null, timeoutMs = this.timeoutMs, dropOnFloodWait = false } = {}) {
    if (method === 'answerInlineQuery' && Array.isArray(params?.results)) {
      params = { ...params, results: sanitizeInlineResults(params.results) };
    }
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
      // Flood wait handling: if caller requests dropping on flood wait, immediately reject without blocking
      if (data.error_code === 429 && data.parameters?.retry_after) {
        if (dropOnFloodWait) {
          err.code = 'FLOOD_WAIT';
          err.retryAfter = data.parameters.retry_after;
          throw err;
        }
        const wait = Math.min(30, Number(data.parameters.retry_after) + 1);
        err._floodAttempts = (params.__floodAttempts ?? 0);
        if (err._floodAttempts >= 2) { throw err; }
        this.log.warn({ method, wait }, 'flood wait — backing off');
        await sleep(wait * 1000);
        return this.call(method, { ...params, __floodAttempts: err._floodAttempts + 1 }, { files, timeoutMs, dropOnFloodWait });
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

  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  getChatAdministrators(chatId) {
    return this.call('getChatAdministrators', { chat_id: chatId });
  }

  get botUsername() {
    return this.me?.username ?? '';
  }

  sendMessage(chatId, text, extra = {}) {
    const params = { chat_id: chatId, text, ...extra };
    if (/https?:\/\/[^\s]+/i.test(text) && !params.link_preview_options && params.disable_web_page_preview === undefined) {
      params.link_preview_options = { is_disabled: false, prefer_large_media: true };
    }
    return this.call('sendMessage', params);
  }

  /** Bot API 10.1+: send a Rich Message. rich_message = InputRichMessage or { html: '...' } */
  sendRichMessage(chatId, richMessage, extra = {}, files = null) {
    let payload = richMessage;
    if (typeof richMessage === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage).toJSON();
    } else if (richMessage && typeof richMessage.html === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage.html).toJSON();
    }
    return this.call('sendRichMessage', { chat_id: chatId, rich_message: payload, ...extra }, { files });
  }

  /** Edit a message's rich content (Bot API 10.1+ rich_message param). */
  editMessageRich(chatId, messageId, richMessage, extra = {}, files = null) {
    let payload = richMessage;
    if (typeof richMessage === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage).toJSON();
    } else if (richMessage && typeof richMessage.html === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage.html).toJSON();
    }
    const dropOnFloodWait = Boolean(extra?.dropOnFloodWait);
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      rich_message: payload,
      ...extra
    }, { files, dropOnFloodWait });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    const params = { chat_id: chatId, message_id: messageId, text, ...extra };
    if (/https?:\/\/[^\s]+/i.test(text) && !params.link_preview_options && params.disable_web_page_preview === undefined) {
      params.link_preview_options = { is_disabled: false, prefer_large_media: true };
    }
    return this.call('editMessageText', params);
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  editMessageMedia(params, extra = {}) {
    return this.call('editMessageMedia', { ...params, ...extra });
  }

  editMessageCaption(params, extra = {}) {
    return this.call('editMessageCaption', { ...params, ...extra });
  }

  sendMediaGroup(chatId, media, extra = {}, files = null) {
    return this.call('sendMediaGroup', { chat_id: chatId, media, ...extra }, { files });
  }

  sendPhoto(chatId, photo, extra = {}, files = null) {
    if (Buffer.isBuffer(photo)) {
      const filename = extra.filename ?? 'photo.jpg';
      const contentType = extra.contentType ?? (filename.endsWith('.png') ? 'image/png' : 'image/jpeg');
      return this.call('sendPhoto', { chat_id: chatId, photo: 'attach://photo', ...extra }, {
        files: { photo: { buffer: photo, filename, contentType } }
      });
    }
    const params = { chat_id: chatId, ...extra };
    if (files?.photo) {
      params.photo = 'attach://photo';
      return this.call('sendPhoto', params, { files });
    }
    params.photo = photo;
    return this.call('sendPhoto', params);
  }

  sendVideo(chatId, video, extra = {}, files = null) {
    if (Buffer.isBuffer(video)) {
      return this.call('sendVideo', { chat_id: chatId, video: 'attach://video', ...extra }, {
        files: { video: { buffer: video, filename: extra.filename ?? 'video.mp4', contentType: 'video/mp4' } }
      });
    }
    const params = { chat_id: chatId, ...extra };
    if (files?.video) {
      params.video = 'attach://video';
      return this.call('sendVideo', params, { files });
    }
    params.video = video;
    return this.call('sendVideo', params);
  }

  sendAnimation(chatId, animation, extra = {}, files = null) {
    if (Buffer.isBuffer(animation)) {
      return this.call('sendAnimation', { chat_id: chatId, animation: 'attach://animation', ...extra }, {
        files: { animation: { buffer: animation, filename: extra.filename ?? 'animation.mp4', contentType: 'video/mp4' } }
      });
    }
    const params = { chat_id: chatId, ...extra };
    if (files?.animation) {
      params.animation = 'attach://animation';
      return this.call('sendAnimation', params, { files });
    }
    params.animation = animation;
    return this.call('sendAnimation', params);
  }

  sendAudio(chatId, audio, extra = {}, files = null) {
    const { filename = 'audio.mp3', thumbnail = null, ...restExtra } = extra;
    const allFiles = files ? { ...files } : {};
    const params = { chat_id: chatId, ...restExtra };

    if (Buffer.isBuffer(audio)) {
      params.audio = 'attach://audio';
      allFiles.audio = { buffer: audio, filename, contentType: 'audio/mpeg' };
    } else if (allFiles.audio) {
      params.audio = 'attach://audio';
    } else {
      params.audio = audio;
    }

    if (Buffer.isBuffer(thumbnail)) {
      params.thumbnail = 'attach://thumbnail';
      allFiles.thumbnail = { buffer: thumbnail, filename: 'thumb.jpg', contentType: 'image/jpeg' };
    } else if (thumbnail) {
      params.thumbnail = thumbnail;
    }

    if (Object.keys(allFiles).length > 0) {
      return this.call('sendAudio', params, { files: allFiles });
    }
    return this.call('sendAudio', params);
  }

  sendDocument(chatId, document, extra = {}, files = null) {
    const { filename = 'file.bin', contentType = 'application/octet-stream', ...restExtra } = extra;
    const allFiles = files ? { ...files } : {};
    const params = { chat_id: chatId, ...restExtra };

    if (Buffer.isBuffer(document)) {
      params.document = 'attach://document';
      allFiles.document = { buffer: document, filename, contentType };
    } else if (allFiles.document) {
      params.document = 'attach://document';
    } else {
      params.document = document;
    }

    if (Object.keys(allFiles).length > 0) {
      return this.call('sendDocument', params, { files: allFiles });
    }
    return this.call('sendDocument', params);
  }

  sendSticker(chatId, sticker, extra = {}) {
    if (Buffer.isBuffer(sticker) || (typeof sticker === 'object' && sticker !== null && sticker.buffer)) {
      const buf = Buffer.isBuffer(sticker) ? sticker : sticker.buffer;
      const isVideo = extra.is_video || extra.isVideo;
      const filename = isVideo ? 'sticker.webm' : 'sticker.webp';
      const contentType = isVideo ? 'video/webm' : 'image/webp';
      const { is_video, isVideo: _iv, ...cleanExtra } = extra;
      return this.call('sendSticker', { chat_id: chatId, ...cleanExtra }, {
        files: { sticker: { buffer: buf, filename, contentType } }
      });
    }
    return this.call('sendSticker', { chat_id: chatId, sticker, ...extra });
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }

  answerCallbackQuery(id, { text, showAlert = false, show_alert = false, url, cacheTime = 0, cache_time = 0 } = {}) {
    const isAlert = Boolean(show_alert || showAlert);
    return this.call('answerCallbackQuery', {
      callback_query_id: id, text, show_alert: isAlert, url, cache_time: cache_time || cacheTime
    }).catch(() => {});
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);
  }

  pinChatMessage(chatId, messageId, { disableNotification = true } = {}) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: disableNotification }).catch(() => null);
  }

  sendPoll(chatId, question, options, extra = {}) {
    const opts = Array.isArray(options)
      ? options.map((o) => (typeof o === 'string' ? { text: o } : o))
      : [];
    return this.call('sendPoll', {
      chat_id: chatId,
      question,
      options: JSON.stringify(opts),
      ...extra
    });
  }

  stopPoll(chatId, messageId, extra = {}) {
    return this.call('stopPoll', { chat_id: chatId, message_id: messageId, ...extra });
  }

  getUserProfilePhotos(userId, extra = {}) {
    return this.call('getUserProfilePhotos', { user_id: userId, ...extra });
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  /** Resolve a getFile path: --local servers return an absolute path on disk. */
  async readFileBytes(filePath, { maxBytes = Infinity, signal } = {}) {
    if (this.isLocalServer && String(filePath).startsWith('/')) {
      const { stat, readFile } = await import('node:fs/promises');
      const root = process.env.TELEGRAM_LOCAL_FILES_ROOT || '/var/lib/telegram-bot-api';
      const { resolve } = await import('node:path');
      const full = resolve(filePath);
      if (!full.startsWith(resolve(root) + '/')) throw new Error('Telegram local file is outside the configured Bot API data directory');
      if ((await stat(full)).size > maxBytes) throw new Error('Telegram file exceeds the size limit');
      return readFile(full);
    }
    const response = await fetch(`${this.apiRoot}/file/bot${this.token}/${filePath}`, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async downloadFile(filePath) {
    return this.readFileBytes(filePath);
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
    const params = {
      offset,
      timeout,
      allowed_updates: [
        'message',
        'callback_query',
        'edited_message',
        'inline_query',
        'chosen_inline_result',
        'chat_member',
        'my_chat_member',
        'chat_join_request',
        'poll',
        'poll_answer'
      ]
    };
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
